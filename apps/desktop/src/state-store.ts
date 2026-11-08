import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { safeStorage } from "electron";
import type {
  DesktopConnectionRegistration,
  DesktopCredential,
} from "@gitgui/contracts/desktop";

interface PersistedState {
  schemaVersion: 1;
  registrations: DesktopConnectionRegistration[];
  credentials: Record<string, string>;
  environmentNames: Record<string, string>;
}

export class DesktopStateStore {
  private state?: PersistedState;
  private loading?: Promise<PersistedState>;
  private queue = Promise.resolve();

  constructor(private readonly path: string) {}

  async listRegistrations() {
    return structuredClone((await this.load()).registrations);
  }

  async getEnvironmentNames(): Promise<Record<string, string>> {
    return structuredClone((await this.load()).environmentNames);
  }

  async setEnvironmentName(environmentId: string, name: string | null) {
    const id = assertSafeString(environmentId, "environmentId");
    const value = name === null ? null : assertSafeString(name, "environment name");
    if (value !== null && value.length > 512) throw new TypeError("Environment names cannot exceed 512 characters");
    await this.mutate((state) => {
      // Object.fromEntries also handles opaque historical IDs such as __proto__.
      state.environmentNames = Object.fromEntries([
        ...Object.entries(state.environmentNames).filter(([key]) => key !== id),
        ...(value === null ? [] : [[id, value]]),
      ]);
    });
  }

  async saveRegistration(registration: DesktopConnectionRegistration, credential?: DesktopCredential) {
    const safeRegistration = parseRegistration(registration);
    // Onboarding publishes the registration and its protected credential in one
    // file replacement. Neither may survive alone after a failed save.
    const encrypted = credential === undefined ? undefined : this.encryptCredential(credential);
    await this.mutate((state) => {
      state.registrations = state.registrations.filter((entry) => entry.environmentId !== safeRegistration.environmentId);
      state.registrations.push(safeRegistration);
      if (encrypted !== undefined) state.credentials[safeRegistration.environmentId] = encrypted;
    });
  }

  async removeRegistration(environmentId: string) {
    const safeEnvironmentId = assertSafeString(environmentId, "environmentId");
    await this.mutate((state) => {
      state.registrations = state.registrations.filter((entry) => entry.environmentId !== safeEnvironmentId);
      delete state.credentials[safeEnvironmentId];
    });
  }

  async getCredential(environmentId: string): Promise<DesktopCredential | undefined> {
    const safeEnvironmentId = assertSafeString(environmentId, "environmentId");
    const encrypted = (await this.load()).credentials[safeEnvironmentId];
    if (!encrypted) return undefined;
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Operating-system credential encryption is unavailable");
    return parseCredential(JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, "base64"))));
  }

  async setCredential(environmentId: string, credential: DesktopCredential) {
    const safeEnvironmentId = assertSafeString(environmentId, "environmentId");
    const encrypted = this.encryptCredential(credential);
    await this.mutate((state) => { state.credentials[safeEnvironmentId] = encrypted; });
  }

  private encryptCredential(credential: DesktopCredential): string {
    const safeCredential = parseCredential(credential);
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Operating-system credential encryption is unavailable");
    return safeStorage.encryptString(JSON.stringify(safeCredential)).toString("base64");
  }

  async removeCredential(environmentId: string) {
    const safeEnvironmentId = assertSafeString(environmentId, "environmentId");
    await this.mutate((state) => { delete state.credentials[safeEnvironmentId]; });
  }

  private async load(): Promise<PersistedState> {
    if (this.state) return this.state;
    if (this.loading) return this.loading;
    this.loading = this.readState();
    try {
      return await this.loading;
    } finally {
      this.loading = undefined;
    }
  }

  private async readState(): Promise<PersistedState> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      // Missing is the only state that can safely start as empty. A failed
      // read must not be cached, so a later retry can recover the real file.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw new Error("Could not read desktop connection state.", { cause: error });
    }
    try {
      this.state = parseState(JSON.parse(raw));
    } catch {
      // JSON parser errors may include fragments of the persisted document.
      throw new Error("Invalid desktop connection state; existing data was preserved.");
    }
    return this.state;
  }

  private async mutate(operation: (state: PersistedState) => void) {
    const run = this.queue.then(async () => {
      const next = structuredClone(await this.load());
      operation(next);
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.tmp-${process.pid}`;
      try {
        await writeFile(temporary, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
        await rename(temporary, this.path);
        // Readers must observe only committed state. A rejected write leaves
        // both the cached registrations and protected credentials untouched.
        this.state = next;
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function emptyState(): PersistedState {
  return { schemaVersion: 1, registrations: [], credentials: {}, environmentNames: {} };
}

function parseState(value: unknown): PersistedState {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.registrations) || !isRecord(value.credentials)) {
    throw new TypeError("Invalid desktop connection state document");
  }
  // Older version 1 documents did not contain environmentNames.
  if (value.environmentNames !== undefined && !isRecord(value.environmentNames)) {
    throw new TypeError("Invalid desktop environment names");
  }
  const credentials = Object.fromEntries(Object.entries(value.credentials).map(([id, encrypted]) => {
    if (typeof encrypted !== "string" || !encrypted) throw new TypeError("Invalid encrypted credential");
    return [assertSafeString(id, "environmentId"), encrypted];
  }));
  const environmentNames = Object.fromEntries(Object.entries(value.environmentNames ?? {}).map(([id, name]) => {
    const safeName = assertSafeString(name, "environment name");
    if (safeName.length > 512) throw new TypeError("Invalid environment name");
    return [assertSafeString(id, "environmentId"), safeName];
  }));
  return { schemaVersion: 1, registrations: value.registrations.map(parsePersistedRegistration), credentials, environmentNames };
}

function parsePersistedRegistration(value: unknown): DesktopConnectionRegistration {
  if (!isRecord(value)) throw new TypeError("Invalid desktop connection registration");
  // Missing historical optional fields retain their old defaults; malformed
  // fields must not be silently filtered out and overwritten on the next save.
  if (value.displayName !== undefined && (typeof value.displayName !== "string" || !value.displayName.trim() || value.displayName.trim().length > 512)) {
    throw new TypeError("Invalid desktop connection display name");
  }
  if (value.capabilities !== undefined && (!Array.isArray(value.capabilities) ||
      value.capabilities.some((item) => typeof item !== "string" || item.length > 256))) {
    throw new TypeError("Invalid desktop connection capabilities");
  }
  if (value.lastConnectedAt !== undefined && (typeof value.lastConnectedAt !== "number" || !Number.isFinite(value.lastConnectedAt))) {
    throw new TypeError("Invalid desktop connection timestamp");
  }
  return parseRegistration(value);
}

function parseRegistration(value: unknown): DesktopConnectionRegistration {
  if (!isRecord(value)) throw new TypeError("Invalid desktop connection registration");
  const environmentId = assertSafeString(value.environmentId, "environmentId");
  const displayName = typeof value.displayName === "string" && value.displayName.trim()
    ? value.displayName.trim().slice(0, 512)
    : environmentId;
  if (typeof value.record !== "string" || value.record.length > 1_000_000) {
    throw new TypeError("Invalid desktop connection record");
  }
  const capabilities = Array.isArray(value.capabilities)
    ? value.capabilities.filter((item): item is string => typeof item === "string" && item.length <= 256)
    : [];
  if (!Number.isInteger(value.protocolVersion) || Number(value.protocolVersion) < 0) {
    throw new TypeError("Invalid desktop protocol version");
  }
  return {
    environmentId,
    displayName,
    record: value.record,
    capabilities,
    protocolVersion: Number(value.protocolVersion),
    ...(typeof value.lastConnectedAt === "number" && Number.isFinite(value.lastConnectedAt)
      ? { lastConnectedAt: value.lastConnectedAt }
      : {}),
  };
}

function parseCredential(value: unknown): DesktopCredential {
  if (!isRecord(value) || (value.kind !== "bootstrap" && value.kind !== "pairing" && value.kind !== "bearer")) {
    throw new TypeError("Invalid desktop credential");
  }
  const token = assertSafeString(value.token, "credential token");
  return {
    kind: value.kind,
    token,
    ...(typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt) ? { expiresAt: value.expiresAt } : {}),
  };
}

function assertSafeString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
