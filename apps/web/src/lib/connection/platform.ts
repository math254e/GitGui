import type {
  DesktopBridge,
  DesktopConnectionRegistration,
  DesktopCredential,
} from "@gitgui/contracts/desktop";
import {
  ConnectionFailure,
  discoverEnvironment,
  LocalStorageCatalogStore,
  LocalStorageCredentialStore,
  type ConnectionCatalogStore,
  type ConnectionCredential,
  type ConnectionPlatform,
  type ConnectionRegistration,
  type CredentialStore,
  type PlatformPreparedConnection,
  type RuntimeWakeup,
  type SshConnectionTarget,
} from "@gitgui/client-runtime";
import { LocalStorageWorkspaceMetadataAdapter } from "$lib/client-runtime";

export interface WebConnectionServices {
  platform: ConnectionPlatform;
  catalog: ConnectionCatalogStore;
  credentials: CredentialStore;
  desktop: DesktopBridge | null;
}

export function createConnectionServices(): WebConnectionServices {
  const desktop = window.desktopBridge ?? null;
  return {
    desktop,
    platform: new WebConnectionPlatform(desktop),
    catalog: desktop ? new DesktopCatalogStore(desktop, localStorage) : new LocalStorageCatalogStore(localStorage),
    credentials: desktop ? new DesktopCredentialStore(desktop) : new LocalStorageCredentialStore(localStorage),
  };
}

class WebConnectionPlatform implements ConnectionPlatform {
  constructor(private readonly desktop: DesktopBridge | null) {}

  isOnline(): boolean {
    return navigator.onLine;
  }

  subscribeNetwork(listener: (online: boolean) => void): () => void {
    const online = () => listener(true);
    const offline = () => listener(false);
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }

  subscribeWakeups(listener: (wakeup: RuntimeWakeup) => void): () => void {
    const focus = () => listener("application-active");
    const visibility = () => { if (document.visibilityState === "visible") focus(); };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visibility);
    const unsubscribeDesktop = this.desktop?.onApplicationWakeup(focus);
    return () => {
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visibility);
      unsubscribeDesktop?.();
    };
  }

  async getPrimaryConnection(signal: AbortSignal): Promise<PlatformPreparedConnection | null> {
    if (this.desktop) return await this.desktop.getPrimaryEnvironment();
    const page = new URL(window.location.href);
    const endpoint = page.searchParams.get("server")?.trim() || window.location.origin;
    validateDirectEndpoint(endpoint, false);
    const descriptor = await discoverEnvironment(endpoint, signal);
    const fragment = new URLSearchParams(page.hash.replace(/^#/, ""));
    const token = fragment.get("token") ?? fragment.get("bootstrap") ?? fragment.get("session_token");
    if (page.hash) {
      page.hash = "";
      history.replaceState(history.state, "", page);
    }
    return {
      httpUrl: endpoint,
      descriptor,
      ...(token ? { credential: { kind: "pairing" as const, token } } : {}),
    };
  }

  async ensureSshConnection(target: SshConnectionTarget): Promise<PlatformPreparedConnection> {
    if (!this.desktop) throw new ConnectionFailure("SSH environments require the GitGui desktop app", "configuration", false);
    return await this.desktop.ensureSshConnection(target);
  }

  async disconnectSshConnection(target: SshConnectionTarget): Promise<void> {
    await this.desktop?.disconnectSshConnection(target);
  }

  async cleanupEnvironment(environmentId: string): Promise<void> {
    await new LocalStorageWorkspaceMetadataAdapter(localStorage).remove({ environmentId });
  }
}

class DesktopCatalogStore implements ConnectionCatalogStore {
  private readonly selectedKey = "gitgui.selectedEnvironment.v2";
  constructor(private readonly bridge: DesktopBridge, private readonly storage: Storage) {}
  async load() {
    const registrations = (await this.bridge.listConnectionRegistrations()) as unknown as ConnectionRegistration[];
    const selectedEnvironmentId = this.storage.getItem(this.selectedKey) ?? undefined;
    return { registrations, selectedEnvironmentId };
  }
  async save(registration: ConnectionRegistration) {
    await this.bridge.saveConnectionRegistration(registration as unknown as DesktopConnectionRegistration);
  }
  async remove(environmentId: string) {
    await this.bridge.removeConnectionRegistration(environmentId);
  }
  async saveSelected(environmentId: string | undefined) {
    if (environmentId) this.storage.setItem(this.selectedKey, environmentId);
    else this.storage.removeItem(this.selectedKey);
  }
}

class DesktopCredentialStore implements CredentialStore {
  constructor(private readonly bridge: DesktopBridge) {}
  async get(environmentId: string) {
    return await this.bridge.getCredential(environmentId) as ConnectionCredential | undefined;
  }
  async set(environmentId: string, credential: ConnectionCredential) {
    await this.bridge.setCredential(environmentId, credential as DesktopCredential);
  }
  async remove(environmentId: string) {
    await this.bridge.removeCredential(environmentId);
  }
}

export function validateDirectEndpoint(endpoint: string, desktop: boolean): void {
  const url = new URL(endpoint);
  if (url.username || url.password || url.search || url.hash) {
    throw new ConnectionFailure("Connection URLs cannot contain credentials, query parameters, or fragments", "configuration", false);
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConnectionFailure("Connection URLs must use HTTP or HTTPS", "configuration", false);
  }
  if (!desktop && url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new ConnectionFailure("Browser connections require HTTPS except on loopback", "configuration", false);
  }
  if (!desktop && window.location.protocol === "https:" && url.protocol !== "https:") {
    throw new ConnectionFailure("An HTTPS client cannot connect to an HTTP backend", "configuration", false);
  }
}
