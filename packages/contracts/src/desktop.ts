import type { EnvironmentDescriptor } from "./protocol.js";

export interface DesktopCredential {
  kind: "bootstrap" | "pairing" | "bearer";
  token: string;
  expiresAt?: number;
}

export interface DesktopPreparedConnection {
  httpUrl: string;
  descriptor: EnvironmentDescriptor;
  credential?: DesktopCredential;
}

export interface DesktopConnectionRegistration {
  environmentId: string;
  displayName: string;
  /**
   * The client-owned registration record, stored verbatim.
   *
   * The desktop shell owns credential protection and persistence, not the
   * shape of the client's connection catalog.
   */
  record: string;
  capabilities: string[];
  protocolVersion: number;
  lastConnectedAt?: number;
}

export interface DesktopSshTarget {
  kind: "ssh";
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
}

export interface DesktopSshHost {
  alias: string;
  hostname?: string;
  user?: string;
  port?: number;
  source: "ssh-config" | "known-hosts";
}

export interface DesktopUpdateStatus {
  phase: "disabled" | "idle" | "checking" | "available" | "current" | "downloaded" | "error";
  version?: string;
  message?: string;
}

export interface DesktopBridge {
  getPrimaryEnvironment(): Promise<DesktopPreparedConnection>;
  restartPrimaryEnvironment(): Promise<DesktopPreparedConnection>;
  listConnectionRegistrations(): Promise<DesktopConnectionRegistration[]>;
  saveConnectionRegistration(registration: DesktopConnectionRegistration): Promise<void>;
  removeConnectionRegistration(environmentId: string): Promise<void>;
  getCredential(environmentId: string): Promise<DesktopCredential | undefined>;
  setCredential(environmentId: string, credential: DesktopCredential): Promise<void>;
  removeCredential(environmentId: string): Promise<void>;
  pickFolder(): Promise<string | null>;
  discoverSshHosts(): Promise<DesktopSshHost[]>;
  ensureSshConnection(target: DesktopSshTarget): Promise<DesktopPreparedConnection>;
  disconnectSshConnection(target: DesktopSshTarget): Promise<void>;
  getUpdateStatus(): Promise<DesktopUpdateStatus>;
  checkForUpdates(): Promise<DesktopUpdateStatus>;
  installUpdate(): Promise<void>;
  onUpdateStatus(listener: (status: DesktopUpdateStatus) => void): () => void;
  onDeepLink(listener: (url: string) => void): () => void;
  onApplicationWakeup(listener: () => void): () => void;
}
