import { isValidEnvironmentId } from "@gitgui/contracts/environment";
import { getContext, setContext } from "svelte";
import {
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
  GitGuiClient,
  type ConnectionCatalogEntry,
  type ConnectionRegistration,
  type SupervisorConnectionState,
} from "@gitgui/client-runtime";
import * as EnvironmentRegistry from "@gitgui/client-runtime/connection/registry";
import { ConnectionCredentialStore } from "@gitgui/client-runtime/connection/credentialStore";
import * as EnvironmentSupervisor from "@gitgui/client-runtime/connection/supervisor";
import { ConnectionWakeups, shouldResubscribeAfterWakeup } from "@gitgui/client-runtime/connection/wakeups";
import { ConnectionOnboarding } from "@gitgui/client-runtime/connection/onboarding";
import { fetchRemoteEnvironmentDescriptor } from "@gitgui/client-runtime/environment/descriptor";
import { defaultEnvironmentName, environmentName } from "@gitgui/client-runtime/environment/names";
import { mapRemoteEnvironmentError } from "@gitgui/client-runtime/connection/errors";
import type { RpcSession } from "@gitgui/client-runtime/rpc/session";
import { request as environmentRequest } from "@gitgui/client-runtime/rpc";
import type { GitGuiRpcMethod, GitGuiRpcMethods } from "@gitgui/client-runtime/rpc";
import { groupRepositoryCatalogs, type RepositoryGroup, type ScopedRepositorySummary } from "@gitgui/client-runtime/workspace";
import type { RepositorySummary } from "@gitgui/contracts";
import { ConnectionBlockedError } from "@gitgui/client-runtime/connection/model";
import { EnvironmentId, type EnvironmentDescriptor } from "@gitgui/contracts/environment";
import { ClientWorkspace, LocalStorageWorkspaceMetadataAdapter, type ClientWorkspaceState } from "../client-runtime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { RepositoryCatalogCache } from "./repository-catalog-cache";
import { EnvironmentWorkspaceData, type EnvironmentWorkspaceView } from "./environment-workspace";
import { EnvironmentWorkspaceRemovalJournal } from "../client-runtime/application-workspace-metadata";
import {
  BrowserPrimaryHintOwner,
  authorizeConnectionCredential,
  discoverSshHosts,
  readDesktopBridge,
  readEnvironmentNames,
  writeEnvironmentName,
  primaryConnectionRegistration,
  readSelectedEnvironmentId,
  validateDirectEndpoint,
  webConnectionLayer,
  writeSelectedEnvironmentId,
  type WebConnectionLayer,
  type WebConnectionOptions,
} from "./platform";

const CONTEXT_KEY = Symbol("gitgui.connection-runtime");

export interface EnvironmentRegistrationView {
  readonly environmentId: string;
  readonly displayName: string;
  readonly target: { readonly kind: string };
}

export interface EnvironmentEntryView {
  readonly registration: EnvironmentRegistrationView;
  readonly connection: SupervisorConnectionState;
}

/** A server's generic local label is relative to its own host, not this client. */
export function connectionDisplayName(entry: ConnectionCatalogEntry): string {
  let host: string | undefined;
  if (Option.isSome(entry.profile)) {
    const profile = entry.profile.value;
    if (profile._tag === "SshConnectionProfile") host = profile.target.alias || profile.target.hostname;
    else {
      try { host = new URL(profile.httpBaseUrl).hostname; } catch { /* Retain a usable label for invalid saved endpoints. */ }
    }
  }
  return defaultEnvironmentName(entry.target.label, host);
}

export interface EnvironmentRegistryView {
  readonly entries: ReadonlyArray<EnvironmentEntryView>;
  readonly selectedEnvironmentId?: string;
}

export interface EnvironmentRepositoryCatalogView {
  readonly repositories: readonly RepositorySummary[];
  readonly status: "empty" | "syncing" | "live" | "stale";
  readonly hasSnapshot: boolean;
  readonly error: string | null;
}

export interface WebWorkspaceOptions {
  readonly tabOwnership?: "legacy" | "external";
}

export interface WebApplicationRuntimeState {
  /** Explicit removals awaiting durable application-tab cleanup. */
  removedEnvironmentIds?: readonly string[];
  registry: EnvironmentRegistryView;
  catalogs: Readonly<Record<string, EnvironmentRepositoryCatalogView>>;
  /** Always supplied by this runtime; optional for legacy state adapters. */
  environmentWorkspaces?: Readonly<Record<string, EnvironmentWorkspaceView>>;
  repositoryGroups: readonly RepositoryGroup<ScopedRepositorySummary>[];
  connection: SupervisorConnectionState | null;
  client: GitGuiClient | null;
  workspace: ClientWorkspace | null;
  workspaceState: ClientWorkspaceState | null;
  loading: boolean;
  error: string;
  sshCleanupNotice?: string;
}

const emptyConnection: SupervisorConnectionState = {
  desired: false,
  network: "unknown",
  phase: "available",
  stage: null,
  attempt: 0,
  generation: 0,
  lastFailure: null,
  retryAt: null,
};

/**
 * The Svelte adapter over the Effect connection runtime.
 *
 * The runtime owns the sockets, the retries, and the environment registry. This
 * class only projects that state into the shape the Svelte components read.
 */
export class WebApplicationRuntime {
  readonly isDesktop: boolean;
  private readonly options: WebConnectionOptions;
  private readonly browserPrimaryHint = new BrowserPrimaryHintOwner();
  private readonly runtime: ManagedRuntime.ManagedRuntime<
    Layer.Success<WebConnectionLayer>,
    Layer.Error<WebConnectionLayer>
  >;
  private stateValue: WebApplicationRuntimeState = {
    registry: { entries: [] },
    catalogs: {},
    environmentWorkspaces: {},
    repositoryGroups: [],
    connection: null,
    client: null,
    workspace: null,
    workspaceState: null,
    loading: true,
    error: "",
    sshCleanupNotice: "",
  };
  private readonly listeners = new Set<(state: WebApplicationRuntimeState) => void>();
  private readonly workspaces = new Map<string, EnvironmentWorkspaceData>();
  private readonly connectionStates = new Map<string, SupervisorConnectionState>();
  private readonly environmentWatchers = new Map<string, Fiber.Fiber<void, unknown>>();
  private readonly catalogWatchers = new Map<string, Fiber.Fiber<void, unknown>>();
  private readonly catalogSessions = new Map<string, RpcSession>();
  private readonly catalogRequests = new Map<string, AbortController>();
  private readonly catalogRefreshes = new Map<string, { session: RpcSession; promise: Promise<void> }>();
  private catalogWakeupWatcher?: Fiber.Fiber<void, unknown>;
  private selectedEnvironmentId: string | null = null;
  private started = false;
  private startupError = "";
  private readonly workspaceSummaryVersions = new Map<string, Map<string, string>>();
  private environmentNames: Readonly<Record<string, string>> = {};

  constructor(options?: WebConnectionOptions, private readonly workspaceOptions: WebWorkspaceOptions = {}) {
    const desktop = readDesktopBridge();
    const supplied = options ?? {
      desktop,
      storage: localStorage,
      fetchFn: globalThis.fetch.bind(globalThis),
    };
    this.options = { ...supplied, onSshCleanup: (status) => {
      supplied.onSshCleanup?.(status);
      this.stateValue.sshCleanupNotice = status.outcome === "cleanup-pending"
        ? "Last SSH cleanup could not be confirmed. Ownership information was retained for reconciliation on the next connection."
        : "Last SSH cleanup retained a shared remote server because it was still in use.";
      this.notify();
    } };
    this.isDesktop = this.options.desktop !== null;
    this.runtime = ManagedRuntime.make(webConnectionLayer(this.options, undefined, this.browserPrimaryHint));
  }

  get state(): WebApplicationRuntimeState {
    return this.snapshot();
  }

  get tabOwnership(): "legacy" | "external" {
    return this.workspaceOptions.tabOwnership ?? "legacy";
  }

  get environmentWorkspaces(): Readonly<Record<string, EnvironmentWorkspaceView>> {
    return Object.fromEntries([...this.workspaces].map(([id, data]) => [id, data.state]));
  }

  subscribe(listener: (state: WebApplicationRuntimeState) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.startupError = "";
    const selected = await readSelectedEnvironmentId(this.options);
    if (selected !== undefined) {
      this.selectedEnvironmentId = selected;
      this.stateValue.registry = { ...this.stateValue.registry, selectedEnvironmentId: selected };
    }
    try {
      this.environmentNames = await readEnvironmentNames(this.options);
      await this.runtime.runPromise(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
          yield* registry.start;
        }),
      );
      const journal = new EnvironmentWorkspaceRemovalJournal(this.options.storage);
      // Hydrated memory is not a commit record. Recovery resolves each intent
      // against durable targets under the same lease as registration and removal.
      this.stateValue.removedEnvironmentIds = journal.load();
    } catch (error) {
      this.stateValue.loading = false;
      this.startupError = formatError(error);
      this.notify();
      return;
    }
    const runtime = this;
    this.catalogWakeupWatcher = this.runtime.runFork(Effect.gen(function* () {
      const wakeups = yield* ConnectionWakeups;
      yield* wakeups.changes.pipe(
        Stream.filter(shouldResubscribeAfterWakeup),
        // Focus, visibility and desktop resume can describe the same wakeup.
        Stream.debounce("50 millis"),
        Stream.runForEach(() => Effect.sync(() => {
          for (const environmentId of runtime.catalogSessions.keys()) {
            void runtime.refreshEnvironmentCatalog(environmentId, { coalesce: true });
          }
        })),
      );
    }));
    this.runtime.runFork(
      Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* Stream.merge(
          Stream.fromEffect(SubscriptionRef.get(registry.entries)),
          SubscriptionRef.changes(registry.entries),
        ).pipe(
          Stream.runForEach((entries) => Effect.sync(() => runtime.applyEntries(entries))),
        );
      }),
    );
    this.applySelection();
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.catalogWakeupWatcher) await Effect.runPromise(Fiber.interrupt(this.catalogWakeupWatcher));
    this.catalogWakeupWatcher = undefined;
    for (const watcher of this.environmentWatchers.values()) Effect.runFork(Fiber.interrupt(watcher));
    this.environmentWatchers.clear();
    for (const watcher of this.catalogWatchers.values()) Effect.runFork(Fiber.interrupt(watcher));
    this.catalogWatchers.clear();
    this.catalogSessions.clear();
    for (const request of this.catalogRequests.values()) request.abort();
    this.catalogRequests.clear();
    this.catalogRefreshes.clear();
    for (const workspace of this.workspaces.values()) workspace.dispose();
    this.workspaces.clear();
    this.connectionStates.clear();
    this.workspaceSummaryVersions.clear();
    this.stateValue.catalogs = {};
    await this.runtime.dispose();
    this.notify();
  }

  /** The registry the settings view uses to retry one environment. */
  readonly registry = {
    retry: (environmentId: string): Promise<void> => this.retry(environmentId),
  };

  async retry(environmentId: string): Promise<void> {
    await this.runtime
      .runPromise(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
          const id = EnvironmentId.make(environmentId);
          const entry = (yield* SubscriptionRef.get(registry.entries)).get(id);
          if (entry?.enabled === false) yield* registry.setEnabled(id, true);
          else yield* registry.retryNow(id);
        }),
      )
      .catch(() => undefined);
  }

  /** Capture the environment and payload at invocation; resolve its current session once.
   * A failed mutation is never replayed after a session replacement. */
  async requestEnvironment<K extends GitGuiRpcMethod>(
    environmentId: string, method: K, input: GitGuiRpcMethods[K]["input"], signal?: AbortSignal,
  ): Promise<GitGuiRpcMethods[K]["output"]> {
    if (!this.started || !this.stateValue.registry.entries.some((entry) => entry.registration.environmentId === environmentId)) {
      throw new Error("Environment is not registered.");
    }
    const capturedInput = structuredClone(input);
    return await this.runtime.runPromise(Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      return yield* registry.run(EnvironmentId.make(environmentId), environmentRequest(method, capturedInput));
    }), signal ? { signal } : undefined);
  }

  async retrySelected(restartPrimary = false): Promise<void> {
    const id = this.selectedEnvironmentId;
    if (!id) return;
    const entry = this.stateValue.registry.entries.find(
      (candidate) => candidate.registration.environmentId === id,
    );
    if (restartPrimary && entry?.registration.target.kind === "primary" && this.options.desktop) {
      const prepared = await this.options.desktop.restartPrimaryEnvironment();
      await this.runtime.runPromise(Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.registerPlatform(primaryConnectionRegistration(prepared));
      }));
      await this.retry(prepared.descriptor.environmentId);
      return;
    }
    await this.retry(id);
  }

  selectEnvironment(environmentId: string): void {
    this.selectedEnvironmentId = environmentId;
    this.stateValue.registry = {
      ...this.stateValue.registry,
      selectedEnvironmentId: environmentId,
    };
    this.notify();
    void writeSelectedEnvironmentId(this.options, environmentId);
    this.applySelection();
  }

  async removeEnvironment(environmentId: string): Promise<void> {
    const entry = this.stateValue.registry.entries.find((entry) => entry.registration.environmentId === environmentId);
    if (!entry) throw new Error("Environment is not registered.");
    // Platform primary registrations can arrive late and cannot be removed by
    // this flow. Never journal their temporary absence as an explicit removal.
    if (entry.registration.target.kind === "primary") throw new Error("The primary environment cannot be removed.");
    const journal = new EnvironmentWorkspaceRemovalJournal(this.options.storage);
    journal.begin(environmentId);
    try {
      await this.runtime.runPromise(Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.remove(EnvironmentId.make(environmentId));
      }));
      this.forgetEnvironmentName(environmentId);
      this.recordWorkspaceRemoval(environmentId);
    } catch (error) {
      // Persistence can reject after deleting the catalog record. Preserve the
      // intent even if the registry still has its old in-memory entry.
      this.recordWorkspaceRemoval(environmentId);
      throw error;
    }
  }

  private recordWorkspaceRemoval(environmentId: string): void {
    // A mounted tab owner may already have acknowledged cleanup while registry
    // removal was finishing. Otherwise a later mount must receive the intent.
    if (!new EnvironmentWorkspaceRemovalJournal(this.options.storage).load().includes(environmentId)) return;
    this.stateValue.removedEnvironmentIds = [...new Set([...(this.stateValue.removedEnvironmentIds ?? []), environmentId])];
    this.notify();
  }

  async acknowledgeEnvironmentWorkspaceRemoval(environmentId: string, removeTabs: () => Promise<void>): Promise<void> {
    const journal = new EnvironmentWorkspaceRemovalJournal(this.options.storage);
    if (!journal.load().includes(environmentId)) return;
    const runtime = this;
    await this.runtime.runPromise(Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      yield* registry.recoverRemoval(EnvironmentId.make(environmentId), (removed) => Effect.promise(async () => {
        if (removed) {
          runtime.forgetEnvironmentName(environmentId);
          await removeTabs();
        }
        // A surviving/new registration cancels the old intent. In both cases
        // completion and tab persistence stay inside the registration lease.
        journal.acknowledge(environmentId);
        runtime.stateValue.removedEnvironmentIds = runtime.stateValue.removedEnvironmentIds?.filter((id) => id !== environmentId);
      }));
    }));
  }

  /** Stable environment data, available even when another environment is displayed. */
  getEnvironmentWorkspace(environmentId: string): EnvironmentWorkspaceData | undefined {
    return this.workspaces.get(environmentId);
  }

  async pickFolder(): Promise<string | null> {
    return (await this.options.desktop?.pickFolder()) ?? null;
  }

  async discoverSshHosts() {
    return await discoverSshHosts(this.options.desktop);
  }

  /** Adds a saved environment that speaks the GitGui protocol over HTTP. */
  async addDirect(httpUrl: string, credential?: { readonly kind: string; readonly token: string }, name?: string): Promise<string> {
    const chosenName = name?.trim() ? environmentName(name) : undefined;
    validateDirectEndpoint(httpUrl, this.isDesktop);
    const descriptor = await this.fetchDescriptor(httpUrl);
    const environmentId = descriptor.environmentId;
    const primary = await this.runtime.runPromise(Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const entries = yield* SubscriptionRef.get(registry.entries);
      const target = entries.get(environmentId)?.target;
      return target?._tag === "PrimaryConnectionTarget" ? target : undefined;
    }));
    const normalizedEndpoint = (value: string) => {
      const url = new URL(value);
      return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    };
    if (primary && (this.isDesktop || normalizedEndpoint(httpUrl) !== normalizedEndpoint(primary.httpBaseUrl))) {
      throw new Error("Use the primary environment's configured address to authenticate.");
    }
    const label = chosenName ?? defaultEnvironmentName(descriptor.label, new URL(httpUrl).hostname);
    const bearerCredential = await this.runtime.runPromise(authorizeConnectionCredential(httpUrl, environmentId, credential));
    if (primary) {
      const browserHint = this.browserPrimaryHint;
      await this.runtime.runPromise(Effect.gen(function* () {
        const credentials = yield* ConnectionCredentialStore;
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        // Retire the initial URL grant and serialize its in-flight writes
        // before publishing a replacement credential.
        yield* browserHint.replaceCredential(credentials.put(environmentId, bearerCredential));
        // A healthy existing session still uses its original authenticated
        // grant. Replace it through the supervisor so scopes and subsequent
        // requests are bound to the newly accepted credential.
        yield* registry.run(environmentId, Effect.gen(function* () {
          const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
          yield* supervisor.disconnect;
          yield* supervisor.connect;
        }));
      }));
      if (chosenName !== undefined) await this.saveConfiguredName(environmentId, chosenName);
      return environmentId;
    }
    const connectionId = `bearer:${crypto.randomUUID()}`;
    const registration = new BearerConnectionRegistration({
      target: new BearerConnectionTarget({
        environmentId: descriptor.environmentId,
        label,
        connectionId,
      }),
      profile: new BearerConnectionProfile({
        connectionId,
        environmentId: descriptor.environmentId,
        label,
        httpBaseUrl: httpUrl,
        wsBaseUrl: toWebSocketBaseUrl(httpUrl),
      }),
      credential: bearerCredential,
    });
    await this.register(registration);
    if (chosenName !== undefined) await this.saveConfiguredName(descriptor.environmentId, chosenName);
    return descriptor.environmentId;
  }

  /** Adds a saved environment that the desktop shell reaches over SSH. */
  async addSsh(
    target: {
      readonly kind: "ssh";
      readonly host: string;
      readonly user?: string;
      readonly port?: number;
      readonly identityFile?: string;
      readonly remoteDataDirectory?: string;
      readonly expectedEnvironmentId?: string;
    },
    credential?: { readonly kind: string; readonly token: string },
    signal?: AbortSignal,
    name?: string,
  ): Promise<string> {
    const chosenName = name?.trim() ? environmentName(name) : undefined;
    const desktop = this.options.desktop;
    if (!desktop) {
      throw new ConnectionBlockedError({
        reason: "configuration",
        detail: "SSH environments require the GitGui desktop app.",
      });
    }
    if ((target.remoteDataDirectory !== undefined && !target.expectedEnvironmentId) ||
        (target.expectedEnvironmentId !== undefined && !isValidEnvironmentId(target.expectedEnvironmentId))) {
      throw new ConnectionBlockedError({ reason: "configuration", detail: "Recovering an existing SSH environment requires its saved environment ID." });
    }
    const id = await this.runtime.runPromise(Effect.flatMap(ConnectionOnboarding, (onboarding) =>
      onboarding.registerSsh({ target: {
        alias: target.host, hostname: target.host,
        ...(target.user === undefined ? {} : { username: target.user }),
        ...(target.port === undefined ? {} : { port: target.port }),
        ...(target.identityFile === undefined ? {} : { identityFile: target.identityFile }),
        ...(target.remoteDataDirectory === undefined ? {} : { remoteDataDirectory: target.remoteDataDirectory }),
      }, ...(chosenName === undefined ? {} : { label: chosenName }), ...(credential === undefined ? {} : { credential }),
      ...(target.expectedEnvironmentId === undefined ? {} : { expectedEnvironmentId: EnvironmentId.make(target.expectedEnvironmentId) }) }),
    ), signal === undefined ? undefined : { signal });
    if (chosenName !== undefined) await this.saveConfiguredName(id, chosenName);
    return id;
  }

  /** Naming changes presentation only, including while offline or blocked. */
  async renameEnvironment(environmentId: string, name: string): Promise<void> {
    const label = environmentName(name);
    const readEntries = Effect.flatMap(EnvironmentRegistry.EnvironmentRegistry,
      (registry) => SubscriptionRef.get(registry.entries));
    const entries = await this.runtime.runPromise(readEntries);
    if (!entries.has(EnvironmentId.make(environmentId))) throw new Error("The environment is no longer registered.");
    await writeEnvironmentName(this.options, environmentId, label);
    this.environmentNames = { ...this.environmentNames, [environmentId]: label };
    this.applyEntries(await this.runtime.runPromise(readEntries));
  }

  private forgetEnvironmentName(environmentId: string): void {
    this.environmentNames = Object.fromEntries(Object.entries(this.environmentNames).filter(([id]) => id !== environmentId));
  }

  private async saveConfiguredName(environmentId: string, name: string): Promise<void> {
    try { await this.renameEnvironment(environmentId, name); }
    catch { throw new Error("The environment connected, but its name could not be saved. Edit its name in Environments to try again."); }
  }

  private async register(registration: ConnectionRegistration): Promise<void> {
    await this.runtime.runPromise(
      Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const registered = yield* registry.register(registration);
        if (!registered) return yield* new ConnectionBlockedError({ reason: "configuration", detail: "This environment is managed by the application." });
      }),
    );
  }

  private async fetchDescriptor(httpUrl: string): Promise<EnvironmentDescriptor> {
    return await this.runtime.runPromise(fetchRemoteEnvironmentDescriptor({ httpBaseUrl: httpUrl })
      .pipe(Effect.mapError(mapRemoteEnvironmentError)));
  }

  private applyEntries(entries: ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>): void {
    if (!this.started) return;
    const views: EnvironmentEntryView[] = [...entries.values()].map((entry) => ({
      registration: {
        environmentId: entry.target.environmentId,
        displayName: Object.hasOwn(this.environmentNames, entry.target.environmentId)
          ? this.environmentNames[entry.target.environmentId]! : connectionDisplayName(entry),
        target: { kind: entry.target._tag === "PrimaryConnectionTarget" ? "primary" : entry.target._tag === "BearerConnectionTarget" ? "bearer" : "ssh" },
      },
      connection: this.connectionStates.get(entry.target.environmentId) ?? emptyConnection,
    }));
    this.stateValue.registry = {
      ...this.stateValue.registry,
      entries: views,
    };
    if (this.selectedEnvironmentId !== null && this.workspaces.has(this.selectedEnvironmentId) &&
        !views.some((entry) => entry.registration.environmentId === this.selectedEnvironmentId)) {
      this.selectedEnvironmentId = null;
      this.stateValue.registry = { entries: views };
    }
    this.watchEnvironments(views);
    this.notify();
    this.applySelection();
  }

  /**
   * One state watcher per known environment, so the settings view can show
   * every environment's phase, not only the selected one.
   */
  private watchEnvironments(entries: ReadonlyArray<EnvironmentEntryView>): void {
    const wanted = new Set(entries.map((entry) => entry.registration.environmentId));
    for (const [environmentId, watcher] of this.environmentWatchers) {
      if (wanted.has(environmentId)) continue;
      Effect.runFork(Fiber.interrupt(watcher));
      this.environmentWatchers.delete(environmentId);
      this.connectionStates.delete(environmentId);
      this.workspaces.get(environmentId)?.dispose();
      this.workspaces.delete(environmentId);
      this.workspaceSummaryVersions.delete(environmentId);
      const catalogWatcher = this.catalogWatchers.get(environmentId);
      if (catalogWatcher) Effect.runFork(Fiber.interrupt(catalogWatcher));
      this.catalogWatchers.delete(environmentId);
      this.catalogSessions.delete(environmentId);
      this.catalogRequests.get(environmentId)?.abort();
      this.catalogRequests.delete(environmentId);
      this.catalogRefreshes.delete(environmentId);
      const catalogs = { ...this.stateValue.catalogs };
      delete catalogs[environmentId];
      this.stateValue.catalogs = catalogs;
    }
    for (const environmentId of wanted) {
      if (this.environmentWatchers.has(environmentId)) continue;
      const cached = new RepositoryCatalogCache(this.options.storage).load(environmentId);
      if (cached !== null) this.stateValue.catalogs = {
        ...this.stateValue.catalogs,
        [environmentId]: { repositories: cached, status: "stale", hasSnapshot: true, error: null },
      };
      this.workspaces.set(environmentId, new EnvironmentWorkspaceData({
        environmentId,
        metadataAdapter: new LocalStorageWorkspaceMetadataAdapter(this.options.storage),
        cachedCatalog: cached ?? [],
        tabOwnership: this.workspaceOptions.tabOwnership,
        request: (method, input, signal) => this.requestEnvironment(environmentId, method, input, signal),
        welcome: (session, signal) => this.runtime.runPromise(session.welcome, { signal }),
        onChange: () => this.onWorkspaceChange(environmentId),
      }));
      const runtime = this;
      const id = EnvironmentId.make(environmentId);
      this.environmentWatchers.set(
        environmentId,
        this.runtime.runFork(
          Effect.gen(function* () {
            const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
            yield* registry.followStream(id, Stream.unwrap(Effect.map(
              EnvironmentSupervisor.EnvironmentSupervisor,
              (supervisor) => SubscriptionRef.changes(supervisor.state),
            ))).pipe(Stream.runForEach((state) =>
              Effect.sync(() => runtime.onEnvironmentState(environmentId, state)),
            ));
          }).pipe(Effect.catch(() => Effect.void)),
        ),
      );
      this.catalogWatchers.set(environmentId, this.runtime.runFork(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
          yield* registry.followStream(id, Stream.unwrap(Effect.map(
            EnvironmentSupervisor.EnvironmentSupervisor,
            (supervisor) => SubscriptionRef.changes(supervisor.session),
          ))).pipe(Stream.runForEach((session) =>
            Effect.sync(() => runtime.onCatalogSession(environmentId, session)),
          ));
        }).pipe(Effect.catch(() => Effect.void)),
      ));
    }
  }

  private onCatalogSession(environmentId: string, session: Option.Option<RpcSession>): void {
    if (!this.started || !this.stateValue.registry.entries.some((entry) => entry.registration.environmentId === environmentId)) return;
    this.workspaces.get(environmentId)?.setSession(Option.getOrNull(session));
    if (Option.isNone(session)) {
      this.catalogSessions.delete(environmentId);
      this.catalogRequests.get(environmentId)?.abort();
      this.catalogRequests.delete(environmentId);
      this.catalogRefreshes.delete(environmentId);
      const previous = this.stateValue.catalogs[environmentId];
      if (previous) this.setCatalog(environmentId, {
        ...previous, status: previous.hasSnapshot ? "stale" : "empty",
      });
      return;
    }
    if (this.catalogSessions.get(environmentId) === session.value) return;
    this.catalogSessions.set(environmentId, session.value);
    void this.refreshEnvironmentCatalog(environmentId);
  }

  /** Wakeups join reads; explicit post-mutation refreshes must supersede older data. */
  refreshEnvironmentCatalog(environmentId: string, options: { readonly coalesce?: boolean } = {}): Promise<void> {
    const session = this.catalogSessions.get(environmentId);
    if (!this.started || !session) return Promise.resolve();
    const pending = this.catalogRefreshes.get(environmentId);
    if (options.coalesce && pending?.session === session) return pending.promise;
    const promise = this.readEnvironmentCatalog(environmentId).finally(() => {
      if (this.catalogRefreshes.get(environmentId)?.promise === promise) this.catalogRefreshes.delete(environmentId);
    });
    this.catalogRefreshes.set(environmentId, { session, promise });
    return promise;
  }

  /** Reads one catalog through that environment's current supervisor session. */
  private async readEnvironmentCatalog(environmentId: string): Promise<void> {
    if (!this.started || !this.catalogSessions.has(environmentId)) return;
    this.catalogRequests.get(environmentId)?.abort();
    const requestToken = new AbortController();
    this.catalogRequests.set(environmentId, requestToken);
    const previous = this.stateValue.catalogs[environmentId];
    const summaryVersions = new Map(this.workspaceSummaryVersions.get(environmentId));
    this.setCatalog(environmentId, {
      repositories: previous?.repositories ?? [], status: "syncing", hasSnapshot: previous?.hasSnapshot ?? false, error: null,
    });
    try {
      const result = await this.runtime.runPromise(Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        return yield* registry.run(EnvironmentId.make(environmentId), environmentRequest("repositories.list", {}));
      }), { signal: requestToken.signal });
      if (this.catalogRequests.get(environmentId) !== requestToken) return;
      // A watcher refresh may finish while this catalog request is in flight.
      // Preserve only those newer live summaries, not an arbitrary old snapshot.
      const changed = new Map<string, RepositorySummary>();
      const currentVersions = this.workspaceSummaryVersions.get(environmentId);
      const repositoriesState = this.workspaces.get(environmentId)?.state.workspaceState.repositories ?? {};
      for (const { repository, snapshot } of Object.values(repositoriesState)) {
        if (snapshot && currentVersions?.get(repository.id) !== summaryVersions.get(repository.id)) changed.set(repository.id, repository);
      }
      const repositories = result.repositories.map((repository) => {
        const newer = changed.get(repository.id);
        changed.delete(repository.id);
        return newer ?? repository;
      });
      repositories.push(...changed.values());
      new RepositoryCatalogCache(this.options.storage).save(environmentId, repositories);
      this.setCatalog(environmentId, { repositories, status: "live", hasSnapshot: true, error: null });
    } catch (error) {
      if (this.catalogRequests.get(environmentId) !== requestToken) return;
      const latest = this.stateValue.catalogs[environmentId] ?? previous;
      this.setCatalog(environmentId, {
        repositories: latest?.repositories ?? [], status: latest?.hasSnapshot ? "stale" : "empty",
        hasSnapshot: latest?.hasSnapshot ?? false, error: formatError(error),
      });
    } finally {
      if (this.catalogRequests.get(environmentId) === requestToken) this.catalogRequests.delete(environmentId);
    }
  }

  private setCatalog(environmentId: string, catalog: EnvironmentRepositoryCatalogView): void {
    this.stateValue.catalogs = { ...this.stateValue.catalogs, [environmentId]: catalog };
    this.notify();
  }

  /** Live repository refreshes own identity changes; grouping must not wait for reconnect. */
  private onWorkspaceChange(environmentId: string): void {
    const workspace = this.workspaces.get(environmentId);
    const catalog = this.stateValue.catalogs[environmentId];
    if (workspace && catalog) {
      const versions = this.workspaceSummaryVersions.get(environmentId) ?? new Map<string, string>();
      this.workspaceSummaryVersions.set(environmentId, versions);
      const changed = new Map<string, RepositorySummary>();
      for (const { repository, snapshot } of Object.values(workspace.state.workspaceState.repositories)) {
        if (!snapshot) continue;
        const version = JSON.stringify(repository);
        if (versions.get(repository.id) === version) continue;
        versions.set(repository.id, version);
        changed.set(repository.id, repository);
      }
      if (changed.size) {
        const repositories = catalog.repositories.map((repository) => {
          const updated = changed.get(repository.id);
          changed.delete(repository.id);
          return updated ?? repository;
        });
        repositories.push(...changed.values());
        new RepositoryCatalogCache(this.options.storage).save(environmentId, repositories);
        this.stateValue.catalogs = { ...this.stateValue.catalogs, [environmentId]: { ...catalog, repositories } };
      }
    }
    this.notify();
  }

  private onEnvironmentState(environmentId: string, state: SupervisorConnectionState): void {
    if (!this.started || !this.workspaces.has(environmentId)) return;
    this.connectionStates.set(environmentId, state);
    this.stateValue.registry = {
      ...this.stateValue.registry,
      entries: this.stateValue.registry.entries.map((entry) =>
        entry.registration.environmentId === environmentId ? { ...entry, connection: state } : entry,
      ),
    };
    this.notify();
  }

  private applySelection(): void {
    const entries = this.stateValue.registry.entries;
    if (this.selectedEnvironmentId === null) {
      const first = entries[0];
      if (first === undefined) return;
      this.selectedEnvironmentId = first.registration.environmentId;
      this.stateValue.registry = {
        ...this.stateValue.registry,
        selectedEnvironmentId: first.registration.environmentId,
      };
      this.notify();
    }
    if (this.selectedEnvironmentId === null ||
        !entries.some((entry) => entry.registration.environmentId === this.selectedEnvironmentId)) return;
    this.notify();
  }

  /** Legacy selected fields are projections of the stable environment services. */
  private projectSelection(): void {
    const id = this.selectedEnvironmentId;
    const view = id === null ? undefined : this.workspaces.get(id)?.state;
    this.stateValue.connection = !this.started || id === null ? null : this.connectionStates.get(id) ?? emptyConnection;
    this.stateValue.client = view?.ready ? view.client : null;
    this.stateValue.workspace = view?.ready ? view.workspace : null;
    this.stateValue.workspaceState = view?.ready ? view.workspaceState : null;
    this.stateValue.loading = this.started && !this.startupError && (!view || view.loading || this.stateValue.connection?.phase !== "connected");
    this.stateValue.error = this.startupError || view?.error || this.stateValue.connection?.lastFailure?.detail || "";
  }

  private snapshot(): WebApplicationRuntimeState {
    return {
      ...this.stateValue,
      registry: { ...this.stateValue.registry, entries: [...this.stateValue.registry.entries] },
      catalogs: { ...this.stateValue.catalogs },
      environmentWorkspaces: this.environmentWorkspaces,
      repositoryGroups: groupRepositoryCatalogs(Object.fromEntries(
        Object.entries(this.stateValue.catalogs).map(([environmentId, catalog]) => [environmentId, catalog.repositories]),
      )),
      connection: this.stateValue.connection ? { ...this.stateValue.connection } : null,
    };
  }

  private notify(): void {
    this.projectSelection();
    const state = this.snapshot();
    for (const listener of this.listeners) listener(state);
  }
}

const toWebSocketBaseUrl = (httpUrl: string): string => {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
};

export function provideWebApplicationRuntime(options?: WebConnectionOptions, workspaceOptions?: WebWorkspaceOptions): WebApplicationRuntime {
  const runtime = new WebApplicationRuntime(options, workspaceOptions);
  setContext(CONTEXT_KEY, runtime);
  return runtime;
}

export function useWebApplicationRuntime(): WebApplicationRuntime {
  const runtime = getContext<WebApplicationRuntime>(CONTEXT_KEY);
  if (!runtime) throw new Error("GitGui connection runtime was not mounted at the application root");
  return runtime;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
