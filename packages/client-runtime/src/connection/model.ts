import type { EnvironmentDescriptor } from "@gitgui/contracts";
import type { GitGuiClient } from "../rpc/client";

export type EnvironmentId = string;

export interface PrimaryConnectionTarget {
  kind: "primary";
}

export interface BearerConnectionTarget {
  kind: "bearer";
  httpUrl: string;
}

export interface SshConnectionTarget {
  kind: "ssh";
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
}

export type ConnectionTarget =
  | PrimaryConnectionTarget
  | BearerConnectionTarget
  | SshConnectionTarget;

export interface ConnectionRegistration {
  environmentId: EnvironmentId;
  displayName: string;
  target: ConnectionTarget;
  capabilities: string[];
  protocolVersion: number;
  lastConnectedAt?: number;
}

export type ConnectionCredential =
  | { kind: "bootstrap"; token: string }
  | { kind: "pairing"; token: string }
  | { kind: "bearer"; token: string; expiresAt?: number };

export interface PlatformPreparedConnection {
  httpUrl: string;
  descriptor: EnvironmentDescriptor;
  credential?: ConnectionCredential;
}

export interface PreparedConnection extends PlatformPreparedConnection {
  websocketTicket?: string;
  accessToken?: string;
}

export interface RpcSession {
  readonly client: GitGuiClient;
  readonly descriptor: EnvironmentDescriptor;
  readonly ready: Promise<void>;
  readonly closed: Promise<Error>;
  probe(signal?: AbortSignal): Promise<void>;
  close(reason?: string): void;
}

export type ConnectionFailureKind =
  | "network"
  | "authentication"
  | "permission"
  | "configuration"
  | "unsupported"
  | "protocol";

export class ConnectionFailure extends Error {
  constructor(
    message: string,
    readonly kind: ConnectionFailureKind,
    readonly transient: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ConnectionFailure";
  }
}

export type ConnectionPhase =
  | "idle"
  | "preparing"
  | "opening"
  | "synchronizing"
  | "connected"
  | "waiting"
  | "blocked"
  | "offline"
  | "stopped";

export type ConnectionStage = "resolving" | "authenticating" | "opening" | "synchronizing" | null;

export interface EnvironmentConnectionState {
  desired: boolean;
  network: "online" | "offline";
  phase: ConnectionPhase;
  stage: ConnectionStage;
  attempt: number;
  generation: number;
  lastFailure: ConnectionFailure | null;
  retryAt: number | null;
}

export interface ConnectionCatalogStore {
  load(): Promise<{ registrations: ConnectionRegistration[]; selectedEnvironmentId?: string }>;
  save(registration: ConnectionRegistration): Promise<void>;
  remove(environmentId: string): Promise<void>;
  saveSelected(environmentId: string | undefined): Promise<void>;
}

export interface CredentialStore {
  get(environmentId: string): Promise<ConnectionCredential | undefined>;
  set(environmentId: string, credential: ConnectionCredential): Promise<void>;
  remove(environmentId: string): Promise<void>;
}

export type RuntimeWakeup = "application-active" | "explicit-retry" | "credential-changed";

export interface ConnectionPlatform {
  isOnline(): boolean;
  subscribeNetwork(listener: (online: boolean) => void): () => void;
  subscribeWakeups(listener: (wakeup: RuntimeWakeup) => void): () => void;
  getPrimaryConnection(signal: AbortSignal): Promise<PlatformPreparedConnection | null>;
  ensureSshConnection(
    target: SshConnectionTarget,
    signal: AbortSignal,
  ): Promise<PlatformPreparedConnection>;
  disconnectSshConnection?(target: SshConnectionTarget): Promise<void>;
  cleanupEnvironment?(environmentId: string): Promise<void>;
}

export function assertEnvironmentId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError("EnvironmentId must be a non-empty safe string");
  }
  return value;
}
