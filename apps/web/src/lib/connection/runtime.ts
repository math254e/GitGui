import { getContext, setContext } from "svelte";
import {
  EnvironmentRegistry,
  type EnvironmentConnectionState,
  type EnvironmentRegistryState,
  type GitGuiClient,
  type ConnectionCredential,
  type SshConnectionTarget,
} from "@gitgui/client-runtime";
import type { DesktopSshHost } from "@gitgui/contracts/desktop";
import { ClientWorkspace, LocalStorageWorkspaceMetadataAdapter, type ClientWorkspaceState } from "$lib/client-runtime";
import { createConnectionServices, validateDirectEndpoint, type WebConnectionServices } from "./platform";

const CONTEXT_KEY = Symbol("gitgui.connection-runtime");

export interface WebApplicationRuntimeState {
  registry: EnvironmentRegistryState;
  connection: EnvironmentConnectionState | null;
  client: GitGuiClient | null;
  workspace: ClientWorkspace | null;
  workspaceState: ClientWorkspaceState | null;
  loading: boolean;
  error: string;
}

export class WebApplicationRuntime {
  readonly registry: EnvironmentRegistry;
  readonly isDesktop: boolean;
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
  private unsubscribeRegistry?: () => void;
  private unsubscribeWorkspace?: () => void;
  private activeSession: object | null = null;
  private activeEnvironmentId: string | null = null;
  private activationGeneration = 0;
  private pendingWorkspace?: ClientWorkspace;
  private readonly revalidate = () => {
    if (document.visibilityState === "visible") this.stateValue.workspace?.revalidate();
  };

  constructor(private readonly services: WebConnectionServices = createConnectionServices()) {
    this.registry = new EnvironmentRegistry(services.catalog, services.credentials, services.platform);
    this.isDesktop = services.desktop !== null;
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
    if (this.unsubscribeRegistry) return;
    window.addEventListener("focus", this.revalidate);
    document.addEventListener("visibilitychange", this.revalidate);
    this.unsubscribeRegistry = this.registry.subscribe((state) => {
      this.stateValue.registry = state;
      void this.activateSelected(state);
      this.notify();
    });
    try {
      await this.registry.start();
    } catch (error) {
      this.stateValue.loading = false;
      this.stateValue.error = formatError(error);
      this.notify();
    }
  }

  async stop(): Promise<void> {
    window.removeEventListener("focus", this.revalidate);
    document.removeEventListener("visibilitychange", this.revalidate);
    this.unsubscribeRegistry?.();
    this.unsubscribeRegistry = undefined;
    this.clearActiveWorkspace(null);
    await this.registry.stop();
  }

  async retrySelected(restartPrimary = false): Promise<void> {
    const id = this.stateValue.registry.selectedEnvironmentId;
    if (!id) return;
    const entry = this.stateValue.registry.entries.find((candidate) => candidate.registration.environmentId === id);
    if (restartPrimary && entry?.registration.target.kind === "primary" && this.services.desktop) {
      await this.services.desktop.restartPrimaryEnvironment();
    }
    this.registry.retry(id);
  }

  async pickFolder(): Promise<string | null> {
    return this.services.desktop?.pickFolder() ?? null;
  }

  async addDirect(httpUrl: string, credential?: ConnectionCredential): Promise<string> {
    validateDirectEndpoint(httpUrl, this.isDesktop);
    const registration = await this.registry.addBearer(httpUrl, credential);
    return registration.environmentId;
  }

  async addSsh(target: SshConnectionTarget, credential?: ConnectionCredential): Promise<string> {
    const registration = await this.registry.addSsh(target, credential);
    return registration.environmentId;
  }

  selectEnvironment(environmentId: string): void {
    this.registry.select(environmentId);
  }

  async removeEnvironment(environmentId: string): Promise<void> {
    await this.registry.remove(environmentId);
  }

  async discoverSshHosts(): Promise<DesktopSshHost[]> {
    return await this.services.desktop?.discoverSshHosts() ?? [];
  }

  private async activateSelected(registry: EnvironmentRegistryState): Promise<void> {
    const selected = registry.entries.find((entry) => entry.registration.environmentId === registry.selectedEnvironmentId);
    this.stateValue.connection = selected?.connection ?? null;
    const selectedEnvironmentId = selected?.registration.environmentId ?? null;
    if (selectedEnvironmentId !== this.activeEnvironmentId) {
      this.clearActiveWorkspace(selectedEnvironmentId);
    }
    if (!selected) {
      this.stateValue.loading = false;
      this.stateValue.error = "No GitGui environment is configured.";
      this.notify();
      return;
    }
    this.stateValue.loading = selected.connection.phase !== "connected" && !this.stateValue.workspace;
    this.stateValue.error = selected.connection.lastFailure?.message ?? "";
    if (!selected.session) {
      this.stateValue.workspace?.stopUpdates();
      this.pendingWorkspace?.dispose();
      this.pendingWorkspace = undefined;
      if (this.activeSession) this.activationGeneration += 1;
      this.activeSession = null;
      return;
    }
    if (selected.session === this.activeSession) return;

    const generation = ++this.activationGeneration;
    this.activeSession = selected.session;
    const workspace = new ClientWorkspace({
      client: selected.session.client,
      identity: { environmentId: selected.registration.environmentId },
      metadataAdapter: new LocalStorageWorkspaceMetadataAdapter(localStorage),
    });
    this.pendingWorkspace?.dispose();
    this.pendingWorkspace = workspace;
    workspace.startUpdates();
    try {
      await workspace.restore();
      if (generation !== this.activationGeneration) { workspace.dispose(); return; }
      this.pendingWorkspace = undefined;
      this.stateValue.workspace?.dispose();
      this.unsubscribeWorkspace?.();
      this.stateValue.client = selected.session.client;
      this.stateValue.workspace = workspace;
      this.stateValue.workspaceState = workspace.state;
      this.stateValue.loading = false;
      this.stateValue.error = "";
      this.unsubscribeWorkspace = workspace.subscribe((workspaceState) => {
        if (generation !== this.activationGeneration) return;
        this.stateValue.workspaceState = workspaceState;
        this.notify();
      });
      this.notify();
    } catch (error) {
      workspace.dispose();
      if (generation !== this.activationGeneration) return;
      this.activeSession = null;
      this.stateValue.loading = false;
      this.stateValue.error = formatError(error);
      this.notify();
    }
  }

  private clearActiveWorkspace(nextEnvironmentId: string | null): void {
    this.activationGeneration += 1;
    this.unsubscribeWorkspace?.();
    this.unsubscribeWorkspace = undefined;
    this.pendingWorkspace?.dispose();
    this.pendingWorkspace = undefined;
    this.stateValue.workspace?.dispose();
    this.activeSession = null;
    this.activeEnvironmentId = nextEnvironmentId;
    this.stateValue.client = null;
    this.stateValue.workspace = null;
    this.stateValue.workspaceState = null;
  }

  private snapshot(): WebApplicationRuntimeState {
    return {
      ...this.stateValue,
      registry: this.stateValue.registry,
      connection: this.stateValue.connection ? { ...this.stateValue.connection } : null,
    };
  }

  private notify(): void {
    const state = this.snapshot();
    for (const listener of this.listeners) listener(state);
  }
}

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
