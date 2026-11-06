/**
 * GitGui-owned Promise adapter for T3's registry-followed workspace reads.
 * Inspected T3 70cd258d8aac43ea57494527b00bf36de3efa6c0:
 * connection/registry.ts (followStream) and rpc/client.ts (currentSession).
 * GitGui's legacy tab projection remains optional; no global tab owner lives here.
 */
import { GitGuiClient } from "@gitgui/client-runtime";
import { GitGuiRpcError, type GitGuiRpcMethod, type GitGuiRpcMethods } from "@gitgui/client-runtime/rpc";
import type { RpcSession } from "@gitgui/client-runtime/rpc/session";
import type { RepositorySummary, WelcomeMessage } from "@gitgui/contracts";
import { PROTOCOL_VERSION } from "@gitgui/contracts/environment";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ClientWorkspace, type ClientWorkspaceState, type PreparedWorkspaceRepository } from "../client-runtime/workspace";
import type { WorkspaceMetadataAdapter } from "../client-runtime/metadata";

export interface EnvironmentWorkspaceView {
  /** Authenticated grant for this live generation; null/absent is unknown. */
  readonly sessionScopes?: readonly string[] | null;
  readonly environmentId: string;
  readonly client: GitGuiClient;
  readonly workspace: ClientWorkspace;
  readonly workspaceState: ClientWorkspaceState;
  readonly welcome: WelcomeMessage | null;
  /** Changes on every loss/replacement, including replacement of a supervisor. */
  readonly generation: number;
  readonly loading: boolean;
  /** Has completed initial activation; remains true across connection loss. */
  readonly ready: boolean;
  readonly error: string;
}

export interface EnvironmentWorkspaceOptions {
  readonly environmentId: string;
  readonly metadataAdapter: WorkspaceMetadataAdapter;
  readonly cachedCatalog?: readonly RepositorySummary[];
  readonly tabOwnership?: "legacy" | "external";
  readonly request: <K extends GitGuiRpcMethod>(method: K, input: GitGuiRpcMethods[K]["input"], signal: AbortSignal) => Promise<GitGuiRpcMethods[K]["output"]>;
  readonly welcome: (session: RpcSession, signal: AbortSignal) => Promise<WelcomeMessage>;
  readonly onChange: () => void;
}

/** One stable data service per registration, independent of the displayed tab. */
export class EnvironmentWorkspaceData {
  readonly client: GitGuiClient;
  readonly workspace: ClientWorkspace;
  readonly initialized: Promise<void>;
  private session: RpcSession | null = null;
  private activation = new AbortController();
  private generation = 0;
  private welcome: WelcomeMessage | null = null;
  private loading = false;
  private ready = false;
  private error = "";
  private disposed = false;
  private hydrationRevision = 0;
  private readonly unsubscribe: () => void;
  private readonly offlineWelcome: WelcomeMessage;

  constructor(private readonly options: EnvironmentWorkspaceOptions) {
    this.offlineWelcome = { type: "welcome", environment_id: options.environmentId,
      server_id: "", protocol_version: PROTOCOL_VERSION, capabilities: [] };
    this.client = new GitGuiClient({
      welcome: this.offlineWelcome,
      client: {
        events: Stream.empty,
        call: (method, input) => {
          const capturedInput = structuredClone(input);
          return Effect.tryPromise({
            try: (signal) => {
              if (this.disposed || !this.session) throw new Error("Environment is not connected.");
              // Evaluate at execution time. A queued action retains this environment,
              // while the registry selects its current session exactly once.
              return options.request(method, capturedInput, AbortSignal.any([signal, this.activation.signal]));
            },
            catch: (error) => error instanceof GitGuiRpcError ? error : new GitGuiRpcError({
              code: "environment_unavailable", message: error instanceof Error ? error.message : String(error),
            }),
          });
        },
      },
    });
    this.workspace = new ClientWorkspace({ client: this.client, identity: { environmentId: options.environmentId },
      metadataAdapter: options.metadataAdapter, tabOwnership: options.tabOwnership });
    this.unsubscribe = this.workspace.subscribe(() => options.onChange());
    this.initialized = this.workspace.restorePlaceholders(options.cachedCatalog).catch((error) => {
      if (!this.disposed) { this.error = String(error); options.onChange(); }
    });
  }

  get state(): EnvironmentWorkspaceView {
    return { environmentId: this.options.environmentId, client: this.client, workspace: this.workspace,
      sessionScopes: this.session?.sessionScopes ?? null,
      workspaceState: this.workspace.state, welcome: this.welcome, generation: this.generation,
      loading: this.loading, ready: this.ready, error: this.error };
  }

  setSession(session: RpcSession | null): void {
    if (this.disposed || session === this.session) return;
    this.session = session;
    this.generation += 1;
    this.activation.abort();
    this.activation = new AbortController();
    this.workspace.stopUpdates();
    this.client.replaceSessionSources({ welcome: this.offlineWelcome, client: { events: Stream.empty } });
    this.welcome = null;
    this.loading = session !== null;
    this.error = "";
    this.options.onChange();
    if (session) void this.activate(session, this.generation, this.activation.signal);
  }

  /** The application tab coordinator supplies its scoped checkout IDs in external mode. */
  async setRepositoryTargets(repositoryIds: readonly string[], activeRepositoryId: string | null = null,
    prepared: readonly (PreparedWorkspaceRepository & { readonly generation: number })[] = []): Promise<void> {
    const ids = [...repositoryIds];
    await this.initialized;
    if (this.disposed) return;
    if (!this.workspace.setRepositoryTargets(ids, activeRepositoryId, prepared.filter((item) => item.generation === this.generation))) return;
    if (this.welcome) {
      this.workspace.startUpdates();
      await this.hydrate(this.generation);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.activation.abort();
    this.unsubscribe();
    this.workspace.dispose();
    this.client.dispose();
  }

  private async activate(session: RpcSession, generation: number, signal: AbortSignal): Promise<void> {
    const current = () => !this.disposed && generation === this.generation;
    try {
      await this.initialized;
      if (!current()) return;
      const welcome = await this.options.welcome(session, signal);
      if (!current()) return;
      if (welcome.environment_id !== this.options.environmentId) throw new Error("Session environment identity does not match its registration.");
      this.welcome = welcome;
      this.client.replaceSessionSources({ welcome, client: session.client, sequenceGaps: session.sequenceGaps });
      this.workspace.startUpdates();
      this.options.onChange();
      await this.hydrate(generation);
    } catch (error) {
      if (!current()) return;
      this.loading = false;
      this.error = error instanceof Error ? error.message : String(error);
      this.options.onChange();
    }
  }

  /** Target changes can cancel activation's reads; only the replacement owns readiness. */
  private async hydrate(generation: number): Promise<void> {
    const revision = ++this.hydrationRevision;
    const current = () => !this.disposed && generation === this.generation && revision === this.hydrationRevision;
    try {
      await this.workspace.hydrate();
      if (!current()) return;
      this.loading = false;
      this.ready = true;
      this.error = "";
    } catch (error) {
      if (!current()) return;
      this.loading = false;
      this.error = error instanceof Error ? error.message : String(error);
    }
    if (current()) this.options.onChange();
  }
}
