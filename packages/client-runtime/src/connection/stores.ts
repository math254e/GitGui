import type {
  ConnectionCatalogStore,
  ConnectionCredential,
  ConnectionRegistration,
  CredentialStore,
} from "./model";
import { assertEnvironmentId } from "./model";

const CATALOG_SCHEMA_VERSION = 2;

export class MemoryCatalogStore implements ConnectionCatalogStore {
  private registrations = new Map<string, ConnectionRegistration>();
  private selectedEnvironmentId?: string;

  async load() {
    return {
      registrations: [...this.registrations.values()].map(cloneRegistration),
      selectedEnvironmentId: this.selectedEnvironmentId,
    };
  }
  async save(registration: ConnectionRegistration) {
    const safe = parseRegistration(registration);
    this.registrations.set(safe.environmentId, safe);
  }
  async remove(environmentId: string) {
    this.registrations.delete(assertEnvironmentId(environmentId));
  }
  async saveSelected(environmentId: string | undefined) {
    this.selectedEnvironmentId = environmentId && assertEnvironmentId(environmentId);
  }
}

export class LocalStorageCatalogStore implements ConnectionCatalogStore {
  constructor(private readonly storage: Storage, private readonly key = "gitgui.connections.v2") {}

  async load() {
    try {
      const raw = this.storage.getItem(this.key);
      if (!raw) return { registrations: [] };
      const value = JSON.parse(raw) as unknown;
      if (!isRecord(value) || value.schemaVersion !== CATALOG_SCHEMA_VERSION || !Array.isArray(value.registrations)) {
        return { registrations: [] };
      }
      const registrations = value.registrations.flatMap((candidate) => {
        try {
          return [parseRegistration(candidate)];
        } catch {
          return [];
        }
      });
      const selectedEnvironmentId = typeof value.selectedEnvironmentId === "string"
        ? assertEnvironmentId(value.selectedEnvironmentId)
        : undefined;
      return { registrations, selectedEnvironmentId };
    } catch {
      return { registrations: [] };
    }
  }

  async save(registration: ConnectionRegistration) {
    const catalog = await this.load();
    const safe = parseRegistration(registration);
    const registrations = catalog.registrations.filter((entry) => entry.environmentId !== safe.environmentId);
    registrations.push(safe);
    this.write(registrations, catalog.selectedEnvironmentId);
  }

  async remove(environmentId: string) {
    const catalog = await this.load();
    const id = assertEnvironmentId(environmentId);
    this.write(
      catalog.registrations.filter((entry) => entry.environmentId !== id),
      catalog.selectedEnvironmentId === id ? undefined : catalog.selectedEnvironmentId,
    );
  }

  async saveSelected(environmentId: string | undefined) {
    const catalog = await this.load();
    this.write(catalog.registrations, environmentId && assertEnvironmentId(environmentId));
  }

  private write(registrations: ConnectionRegistration[], selectedEnvironmentId?: string) {
    this.storage.setItem(this.key, JSON.stringify({
      schemaVersion: CATALOG_SCHEMA_VERSION,
      registrations,
      ...(selectedEnvironmentId ? { selectedEnvironmentId } : {}),
    }));
  }
}

export class MemoryCredentialStore implements CredentialStore {
  private readonly values = new Map<string, ConnectionCredential>();
  async get(environmentId: string) {
    return cloneCredential(this.values.get(assertEnvironmentId(environmentId)));
  }
  async set(environmentId: string, credential: ConnectionCredential) {
    this.values.set(assertEnvironmentId(environmentId), parseCredential(credential));
  }
  async remove(environmentId: string) {
    this.values.delete(assertEnvironmentId(environmentId));
  }
}

export class LocalStorageCredentialStore implements CredentialStore {
  constructor(private readonly storage: Storage, private readonly prefix = "gitgui.credential.v2") {}
  async get(environmentId: string) {
    try {
      const value = this.storage.getItem(this.key(environmentId));
      return value ? parseCredential(JSON.parse(value)) : undefined;
    } catch {
      return undefined;
    }
  }
  async set(environmentId: string, credential: ConnectionCredential) {
    this.storage.setItem(this.key(environmentId), JSON.stringify(parseCredential(credential)));
  }
  async remove(environmentId: string) {
    this.storage.removeItem(this.key(environmentId));
  }
  private key(environmentId: string) {
    return `${this.prefix}.${encodeURIComponent(assertEnvironmentId(environmentId))}`;
  }
}

function parseRegistration(value: unknown): ConnectionRegistration {
  if (!isRecord(value) || !isRecord(value.target)) throw new TypeError("Invalid connection registration");
  const environmentId = assertEnvironmentId(value.environmentId);
  const displayName = typeof value.displayName === "string" && value.displayName.trim()
    ? value.displayName.trim()
    : environmentId;
  const target = parseTarget(value.target);
  const capabilities = Array.isArray(value.capabilities)
    ? value.capabilities.filter((item): item is string => typeof item === "string")
    : [];
  const protocolVersion = Number.isInteger(value.protocolVersion) ? Number(value.protocolVersion) : 0;
  const lastConnectedAt = typeof value.lastConnectedAt === "number" && Number.isFinite(value.lastConnectedAt)
    ? value.lastConnectedAt
    : undefined;
  return { environmentId, displayName, target, capabilities, protocolVersion, ...(lastConnectedAt ? { lastConnectedAt } : {}) };
}

function parseTarget(value: Record<string, unknown>): ConnectionRegistration["target"] {
  if (value.kind === "primary") return { kind: "primary" };
  if (value.kind === "bearer" && typeof value.httpUrl === "string") {
    return { kind: "bearer", httpUrl: normalizeHttpUrl(value.httpUrl) };
  }
  if (value.kind === "ssh" && typeof value.host === "string" && value.host.trim()) {
    return {
      kind: "ssh",
      host: value.host.trim(),
      ...(typeof value.user === "string" && value.user.trim() ? { user: value.user.trim() } : {}),
      ...(Number.isInteger(value.port) ? { port: Number(value.port) } : {}),
      ...(typeof value.identityFile === "string" && value.identityFile.trim() ? { identityFile: value.identityFile.trim() } : {}),
    };
  }
  throw new TypeError("Unsupported connection target");
}

function parseCredential(value: unknown): ConnectionCredential {
  if (!isRecord(value) || (value.kind !== "bootstrap" && value.kind !== "pairing" && value.kind !== "bearer")) {
    throw new TypeError("Invalid connection credential");
  }
  if (typeof value.token !== "string" || !value.token || /[\u0000-\u001f\u007f]/.test(value.token)) {
    throw new TypeError("Invalid connection credential token");
  }
  if (value.kind === "bearer") {
    return {
      kind: "bearer",
      token: value.token,
      ...(typeof value.expiresAt === "number" ? { expiresAt: value.expiresAt } : {}),
    };
  }
  return { kind: value.kind, token: value.token };
}

function normalizeHttpUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("Connection URL must use HTTP or HTTPS");
  if (url.username || url.password || url.search || url.hash) throw new TypeError("Connection URL cannot contain credentials, query, or hash");
  return url.toString().replace(/\/$/, "");
}

function cloneRegistration(value: ConnectionRegistration): ConnectionRegistration {
  return parseRegistration(structuredClone(value));
}

function cloneCredential(value: ConnectionCredential | undefined): ConnectionCredential | undefined {
  return value && parseCredential({ ...value });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
