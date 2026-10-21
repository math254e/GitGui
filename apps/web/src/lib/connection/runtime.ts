import { getContext, setContext } from "svelte";
import {
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
  GitGuiClient,
  SshConnectionProfile,
  SshConnectionRegistration,
  SshConnectionTarget,
  type ConnectionCatalogEntry,
  type ConnectionRegistration,
  type SupervisorConnectionState,
} from "@gitgui/client-runtime";
import * as EnvironmentRegistry from "@gitgui/client-runtime/connection/registry";
import * as EnvironmentSupervisor from "@gitgui/client-runtime/connection/supervisor";
import type { RpcSession } from "@gitgui/client-runtime/rpc/session";
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
import {
  authorizeConnectionCredential,
  discoverSshHosts,
  readDesktopBridge,
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

export interface EnvironmentRegistryView {
  readonly entries: ReadonlyArray<EnvironmentEntryView>;
  readonly selectedEnvironmentId?: string;
}

export interface WebApplicationRuntimeState {
  registry: EnvironmentRegistryView;
  connection: SupervisorConnectionState | null;
  client: GitGuiClient | null;
  workspace: ClientWorkspace | null;
  workspaceState: ClientWorkspaceState | null;
  loading: boolean;
  error: string;
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
  private readonly runtime: ManagedRuntime.ManagedRuntime<
    Layer.Success<WebConnectionLayer>,
    Layer.Error<WebConnectionLayer>
  >;
  private stateValue: WebApplicationRuntimeState = {
    registry: { entries: [] },
    connection: null,
    client: null,
    workspace: null,
    workspaceState: null,
    loading: true,
    error: "",
  };
  private readonly listeners = new Set<(state: WebApplicationRuntimeState) => void>();
  private workspaceListener?: () => void;
  private readonly connectionStates = new Map<string, SupervisorConnectionState>();
  private readonly environmentWatchers = new Map<string, Fiber.Fiber<void, unknown>>();
  private sessionWatcher?: Fiber.Fiber<void, unknown>;
  private watchedEnvironmentId: string | null = null;
  private selectedEnvironmentId: string | null = null;
  private activeSession: RpcSession | null = null;
  private activationGeneration = 0;
  private pendingWorkspace?: ClientWorkspace;
  private pendingClient?: GitGuiClient;
  private started = false;

  constructor(options?: WebConnectionOptions) {
    const desktop = readDesktopBridge();
    this.options = options ?? {
      desktop,
      storage: localStorage,
      fetchFn: globalThis.fetch.bind(globalThis),
    };
    this.isDesktop = this.options.desktop !== null;
    this.runtime = ManagedRuntime.make(webConnectionLayer(this.options));
  }

  get state(): WebApplicationRuntimeState {
    return this.snapshot();
  }

  subscribe(listener: (state: WebApplicationRuntimeState) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const selected = await readSelectedEnvironmentId(this.options);
    if (selected !== undefined) {
      this.selectedEnvironmentId = selected;
      this.stateValue.registry = { ...this.stateValue.registry, selectedEnvironmentId: selected };
    }
    try {
      await this.runtime.runPromise(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
          yield* registry.start;
        }),
      );
    } catch (error) {
      this.stateValue.loading = false;
      this.stateValue.error = formatError(error);
      this.notify();
      return;
    }
    const runtime = this;
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
    if (this.sessionWatcher) Effect.runFork(Fiber.interrupt(this.sessionWatcher));
    this.sessionWatcher = undefined;
    this.watchedEnvironmentId = null;
    for (const watcher of this.environmentWatchers.values()) Effect.runFork(Fiber.interrupt(watcher));
    this.environmentWatchers.clear();
    this.clearActiveWorkspace();
    await this.runtime.dispose();
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
          yield* registry.retryNow(EnvironmentId.make(environmentId));
        }),
      )
      .catch(() => undefined);
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
    if (environmentId === this.selectedEnvironmentId && entry?.registration.target.kind !== "primary") {
      this.clearActiveWorkspace();
    }
    try {
      await this.runtime.runPromise(Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.remove(EnvironmentId.make(environmentId));
      }));
    } catch (error) {
      // Persistence can fail while the registration and session remain usable.
      // Reattach even when selection did not change, rebuilding the workspace
      // disposed before cleanup could remove its metadata.
      if (this.selectedEnvironmentId === environmentId) {
        this.watchedEnvironmentId = null;
        this.applySelection();
      }
      throw error;
    }
  }

  async pickFolder(): Promise<string | null> {
    return (await this.options.desktop?.pickFolder()) ?? null;
  }

  async discoverSshHosts() {
    return await discoverSshHosts(this.options.desktop);
  }

  /** Adds a saved environment that speaks the GitGui protocol over HTTP. */
  async addDirect(httpUrl: string, credential?: { readonly kind: string; readonly token: string }): Promise<string> {
    validateDirectEndpoint(httpUrl, this.isDesktop);
    const descriptor = await this.fetchDescriptor(httpUrl);
    const bearerCredential = await this.runtime.runPromise(authorizeConnectionCredential(httpUrl, descriptor.environmentId, credential));
    const connectionId = `bearer:${crypto.randomUUID()}`;
    const registration = new BearerConnectionRegistration({
      target: new BearerConnectionTarget({
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        connectionId,
      }),
      profile: new BearerConnectionProfile({
        connectionId,
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        httpBaseUrl: httpUrl,
        wsBaseUrl: toWebSocketBaseUrl(httpUrl),
      }),
      credential: bearerCredential,
    });
    await this.register(registration);
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
    },
    credential?: { readonly kind: string; readonly token: string },
  ): Promise<string> {
    const desktop = this.options.desktop;
    if (!desktop) {
      throw new ConnectionBlockedError({
        reason: "configuration",
        detail: "SSH environments require the GitGui desktop app.",
      });
    }
    const prepared = await desktop.ensureSshConnection({
      kind: "ssh",
      host: target.host,
      ...(target.user === undefined ? {} : { user: target.user }),
      ...(target.port === undefined ? {} : { port: target.port }),
      ...(target.identityFile === undefined ? {} : { identityFile: target.identityFile }),
    });
    const descriptor = await this.fetchDescriptor(prepared.httpUrl);
    const bearerCredential = await this.runtime.runPromise(authorizeConnectionCredential(
      prepared.httpUrl, descriptor.environmentId, credential ?? prepared.credential,
    ));
    const connectionId = `ssh:${crypto.randomUUID()}`;
    const registration = new SshConnectionRegistration({
      target: new SshConnectionTarget({
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        connectionId,
      }),
      profile: new SshConnectionProfile({
        connectionId,
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        target: {
          alias: target.host,
          hostname: target.host,
          ...(target.user === undefined ? {} : { username: target.user }),
          ...(target.port === undefined ? {} : { port: target.port }),
          ...(target.identityFile === undefined ? {} : { identityFile: target.identityFile }),
        },
      }),
      credential: bearerCredential,
    });
    await this.register(registration);
    return descriptor.environmentId;
  }

  private async register(registration: ConnectionRegistration): Promise<void> {
    await this.runtime.runPromise(
      Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.register(registration);
      }),
    );
  }

  private async fetchDescriptor(httpUrl: string): Promise<EnvironmentDescriptor> {
    const response = await this.options.fetchFn(
      new URL("/.well-known/gitgui/environment", httpUrl).toString(),
    );
    if (!response.ok) {
      throw new ConnectionBlockedError({
        reason: "configuration",
        detail: `The GitGui environment did not answer (HTTP ${response.status}).`,
      });
    }
    return (await response.json()) as EnvironmentDescriptor;
  }

  private applyEntries(entries: ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>): void {
    const views: EnvironmentEntryView[] = [...entries.values()].map((entry) => ({
      registration: {
        environmentId: entry.target.environmentId,
        displayName: entry.target.label,
        target: { kind: entry.target._tag === "PrimaryConnectionTarget" ? "primary" : entry.target._tag === "BearerConnectionTarget" ? "bearer" : "ssh" },
      },
      connection: this.connectionStates.get(entry.target.environmentId) ?? emptyConnection,
    }));
    this.stateValue.registry = {
      ...this.stateValue.registry,
      entries: views,
    };
    const removedSelection = this.watchedEnvironmentId !== null &&
      !views.some((entry) => entry.registration.environmentId === this.watchedEnvironmentId);
    if (removedSelection) {
      if (this.sessionWatcher) Effect.runFork(Fiber.interrupt(this.sessionWatcher));
      this.sessionWatcher = undefined;
      this.watchedEnvironmentId = null;
      this.selectedEnvironmentId = null;
      this.clearActiveWorkspace();
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
    }
    for (const environmentId of wanted) {
      if (this.environmentWatchers.has(environmentId)) continue;
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
    }
  }

  private onEnvironmentState(environmentId: string, state: SupervisorConnectionState): void {
    this.connectionStates.set(environmentId, state);
    this.stateValue.registry = {
      ...this.stateValue.registry,
      entries: this.stateValue.registry.entries.map((entry) =>
        entry.registration.environmentId === environmentId ? { ...entry, connection: state } : entry,
      ),
    };
    if (environmentId === this.selectedEnvironmentId) {
      this.onState(state);
    }
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
    // One watcher per selected environment: the entries change on every
    // registration, and a watcher per change would leak fibers.
    if (this.watchedEnvironmentId === this.selectedEnvironmentId) return;
    this.clearActiveWorkspace();
    this.stateValue.connection = this.connectionStates.get(this.selectedEnvironmentId) ?? emptyConnection;
    this.stateValue.loading = true;
    this.stateValue.error = "";
    this.watchedEnvironmentId = this.selectedEnvironmentId;
    if (this.sessionWatcher) Effect.runFork(Fiber.interrupt(this.sessionWatcher));
    const runtime = this;
    const environmentId = EnvironmentId.make(this.selectedEnvironmentId);
    this.sessionWatcher = this.runtime.runFork(
      Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.followStream(environmentId, Stream.unwrap(Effect.map(
          EnvironmentSupervisor.EnvironmentSupervisor,
          (supervisor) => SubscriptionRef.changes(supervisor.session),
        ))).pipe(Stream.runForEach((session) => Effect.sync(() => {
          if (runtime.watchedEnvironmentId === environmentId && runtime.selectedEnvironmentId === environmentId) {
            runtime.onSession(session);
          }
        })));
      }),
    );
  }

  private onState(state: SupervisorConnectionState): void {
    this.stateValue.connection = state;
    this.stateValue.loading = state.phase !== "connected";
    this.stateValue.error = state.lastFailure?.detail ?? "";
    this.notify();
  }

  private onSession(session: Option.Option<RpcSession>): void {
    if (Option.isNone(session)) {
      this.clearActiveWorkspace();
      return;
    }
    if (session.value === this.activeSession) return;
    this.clearActiveWorkspace();
    this.activeSession = session.value;
    const generation = ++this.activationGeneration;
    void this.runtime
      .runPromise(session.value.welcome)
      .then((welcome) => {
        if (generation !== this.activationGeneration) return;
        const client = new GitGuiClient({
          client: session.value.client,
          welcome,
          // The transport watches the server's event sequence, so the gap
          // detection lives with the transport.
          sequenceGaps: session.value.sequenceGaps,
        });
        this.pendingClient = client;
        const environmentId = this.selectedEnvironmentId;
        if (environmentId === null) return;
        const workspace = new ClientWorkspace({
          client,
          identity: { environmentId },
          metadataAdapter: new LocalStorageWorkspaceMetadataAdapter(this.options.storage),
        });
        this.pendingWorkspace = workspace;
        workspace.startUpdates();
        void workspace
          .restore()
          .then(() => {
            if (generation !== this.activationGeneration) {
              workspace.dispose();
              client.dispose();
              return;
            }
            this.pendingWorkspace = undefined;
            this.pendingClient = undefined;
            this.stateValue.workspace?.dispose();
            this.stateValue.client?.dispose();
            this.workspaceListener?.();
            this.stateValue.client = client;
            this.stateValue.workspace = workspace;
            this.stateValue.workspaceState = workspace.state;
            this.stateValue.loading = false;
            this.stateValue.error = "";
            this.workspaceListener = workspace.subscribe((workspaceState) => {
              if (generation !== this.activationGeneration) return;
              this.stateValue.workspaceState = workspaceState;
              this.notify();
            });
            this.notify();
          })
          .catch((error) => {
            workspace.dispose();
            client.dispose();
            if (generation !== this.activationGeneration) return;
            this.activeSession = null;
            this.stateValue.loading = false;
            this.stateValue.error = formatError(error);
            this.notify();
          });
      })
      .catch((error) => {
        if (generation !== this.activationGeneration) return;
        this.stateValue.loading = false;
        this.stateValue.error = formatError(error);
        this.notify();
      });
  }

  private clearActiveWorkspace(): void {
    this.activationGeneration += 1;
    this.workspaceListener?.();
    this.workspaceListener = undefined;
    this.pendingWorkspace?.dispose();
    this.pendingWorkspace = undefined;
    this.pendingClient?.dispose();
    this.pendingClient = undefined;
    this.stateValue.workspace?.dispose();
    this.stateValue.client?.dispose();
    this.activeSession = null;
    this.stateValue.client = null;
    this.stateValue.workspace = null;
    this.stateValue.workspaceState = null;
  }

  private snapshot(): WebApplicationRuntimeState {
    return {
      ...this.stateValue,
      registry: { ...this.stateValue.registry, entries: [...this.stateValue.registry.entries] },
      connection: this.stateValue.connection ? { ...this.stateValue.connection } : null,
    };
  }

  private notify(): void {
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

export function provideWebApplicationRuntime(): WebApplicationRuntime {
  const runtime = new WebApplicationRuntime();
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
