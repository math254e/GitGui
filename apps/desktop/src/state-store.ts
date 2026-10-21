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
}

export class DesktopStateStore {
  private state?: PersistedState;
  private queue = Promise.resolve();

  constructor(private readonly path: string) {}

  async listRegistrations() {
    return structuredClone((await this.load()).registrations);
  }

  async saveRegistration(registration: DesktopConnectionRegistration) {
    const safeRegistration = parseRegistration(registration);
    await this.mutate((state) => {
      state.registrations = state.registrations.filter((entry) => entry.environmentId !== safeRegistration.environmentId);
      state.registrations.push(safeRegistration);
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
    const safeCredential = parseCredential(credential);
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Operating-system credential encryption is unavailable");
    const encrypted = safeStorage.encryptString(JSON.stringify(safeCredential)).toString("base64");
    await this.mutate((state) => { state.credentials[safeEnvironmentId] = encrypted; });
  }

  async removeCredential(environmentId: string) {
    const safeEnvironmentId = assertSafeString(environmentId, "environmentId");
    await this.mutate((state) => { delete state.credentials[safeEnvironmentId]; });
  }

  private async load(): Promise<PersistedState> {
    if (this.state) return this.state;
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as PersistedState;
      this.state = parsed.schemaVersion === 1 && Array.isArray(parsed.registrations) && isRecord(parsed.credentials)
        ? {
          schemaVersion: 1,
          registrations: parsed.registrations.flatMap((entry) => {
            try { return [parseRegistration(entry)]; } catch { return []; }
          }),
          credentials: Object.fromEntries(Object.entries(parsed.credentials).filter((entry): entry is [string, string] =>
            typeof entry[0] === "string" && typeof entry[1] === "string",
          )),
        }
        : emptyState();
    } catch {
      this.state = emptyState();
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
  return { schemaVersion: 1, registrations: [], credentials: {} };
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
  return typeof value === "object" && value !== null;
}
