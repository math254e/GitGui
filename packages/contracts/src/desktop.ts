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
  ssh?: { operationId: string; remoteDataDirectory: string };
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
  /** Persisted environment locator; independent of the SSH route/key. */
  remoteDataDirectory?: string;
}

export interface DesktopSshRequest {
  operationId: string;
  expectedEnvironmentId?: string;
}

export type DesktopSshFailureCategory = "transport" | "authentication" | "permission" | "configuration" | "unsupported" | "identity" | "cancelled";
export interface DesktopSshFailure {
  category: DesktopSshFailureCategory;
  message: string;
}

export type DesktopSshResult<T> = { ok: true; value: T } | { ok: false; error: DesktopSshFailure };
export type DesktopSshCleanup = "stopped" | "released" | "retained" | "cleanup-pending";
export interface DesktopSshCleanupReport {
  operationId: string;
  outcome: DesktopSshCleanup;
}

export interface DesktopSshHost {
  alias: string;
  hostname?: string;
  user?: string;
  port?: number;
  source: "ssh-config" | "known-hosts";
}

export interface DesktopUpdateStatus {
  phase: "disabled" | "idle" | "checking" | "available" | "current" | "downloading" | "downloaded" | "installing" | "error";
  currentVersion?: string;
  availableVersion?: string;
  downloadedVersion?: string;
  downloadPercent?: number;
  checkedAt?: string;
  errorContext?: "check" | "download" | "install";
  releaseNotes?: string;
  releaseUrl?: string;
  /** Compatibility display alias; use the explicit version fields for actions. */
  version?: string;
  message?: string;
}

export interface DesktopUpdateActionResult {
  accepted: boolean;
  status: DesktopUpdateStatus;
}

export interface DesktopBridge {
  getPrimaryEnvironment(): Promise<DesktopPreparedConnection>;
  restartPrimaryEnvironment(): Promise<DesktopPreparedConnection>;
  listConnectionRegistrations(): Promise<DesktopConnectionRegistration[]>;
  saveConnectionRegistration(registration: DesktopConnectionRegistration, credential?: DesktopCredential): Promise<void>;
  removeConnectionRegistration(environmentId: string): Promise<void>;
  /** Presentation preferences, keyed by stable identity, including the primary. */
  getEnvironmentNames(): Promise<Record<string, string>>;
  setEnvironmentName(environmentId: string, name: string | null): Promise<void>;
  getCredential(environmentId: string): Promise<DesktopCredential | undefined>;
  setCredential(environmentId: string, credential: DesktopCredential): Promise<void>;
  removeCredential(environmentId: string): Promise<void>;
  pickFolder(): Promise<string | null>;
  discoverSshHosts(): Promise<DesktopSshHost[]>;
  ensureSshConnection(target: DesktopSshTarget, request?: DesktopSshRequest): Promise<DesktopPreparedConnection>;
  issueSshPairingCredential(operationId: string, expectedEnvironmentId: string): Promise<DesktopCredential>;
  claimSshConnection(operationId: string, expectedEnvironmentId: string): Promise<void>;
  cancelSshConnection(operationId: string): Promise<DesktopSshCleanup>;
  disconnectSshConnection(target: DesktopSshTarget): Promise<DesktopSshCleanupReport[]>;
  getUpdateStatus(): Promise<DesktopUpdateStatus>;
  checkForUpdates(): Promise<DesktopUpdateStatus>;
  downloadUpdate(): Promise<DesktopUpdateActionResult>;
  installUpdate(expectedVersion?: string): Promise<DesktopUpdateActionResult>;
  onUpdateStatus(listener: (status: DesktopUpdateStatus) => void): () => void;
  onDeepLink(listener: (url: string) => void): () => void;
  onApplicationWakeup(listener: () => void): () => void;
}
