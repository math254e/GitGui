export const WORKSPACE_METADATA_SCHEMA_VERSION = 1;
export const WORKSPACE_METADATA_MIGRATION_VERSION = 1;

export interface WorkspaceMetadataIdentity {
  /** Stable client-side environment identity. */
  environmentId: string;
  /** Optional host/server identity when the server has supplied one. */
  serverId?: string;
}

export interface WorkspaceRecentMetadata {
  repositoryId: string;
  lastOpenedAt: number;
  order: number;
}

/** Persisted workspace metadata. It intentionally contains IDs only. */
export interface WorkspaceMetadata {
  schemaVersion: number;
  migrationVersion: number;
  openRepositoryIds: string[];
  recentRepositories: WorkspaceRecentMetadata[];
  activeRepositoryId: string | null;
}

export interface WorkspaceMetadataAdapter {
  load(identity: WorkspaceMetadataIdentity): Promise<WorkspaceMetadata | null>;
  save(identity: WorkspaceMetadataIdentity, metadata: WorkspaceMetadata): Promise<void>;
  remove(identity: WorkspaceMetadataIdentity): Promise<void>;
}

export class InMemoryWorkspaceMetadataAdapter implements WorkspaceMetadataAdapter {
  private readonly values = new Map<string, WorkspaceMetadata>();

  constructor(initial: Array<{ identity: WorkspaceMetadataIdentity; metadata: WorkspaceMetadata }> = []) {
    for (const value of initial) this.values.set(workspaceMetadataKey(value.identity), cloneMetadata(value.metadata));
  }

  async load(identity: WorkspaceMetadataIdentity): Promise<WorkspaceMetadata | null> {
    const metadata = this.values.get(workspaceMetadataKey(identity));
    return metadata ? cloneMetadata(metadata) : null;
  }

  async save(identity: WorkspaceMetadataIdentity, metadata: WorkspaceMetadata): Promise<void> {
    this.values.set(workspaceMetadataKey(identity), cloneMetadata(metadata));
  }

  async remove(identity: WorkspaceMetadataIdentity): Promise<void> {
    this.values.delete(workspaceMetadataKey(identity));
  }
}

export class LocalStorageWorkspaceMetadataAdapter implements WorkspaceMetadataAdapter {
  constructor(private readonly storage: Storage, private readonly namespace = "gitgui.workspace") {
    if (typeof namespace !== "string" || !namespace.trim() || /[\u0000-\u001f\u007f]/.test(namespace)) {
      throw new TypeError("Workspace metadata namespace cannot be empty or contain control characters");
    }
  }

  async load(identity: WorkspaceMetadataIdentity): Promise<WorkspaceMetadata | null> {
    const raw = this.storage.getItem(this.key(identity));
    if (!raw) return null;

    try {
      return parseMetadata(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  async save(identity: WorkspaceMetadataIdentity, metadata: WorkspaceMetadata): Promise<void> {
    this.storage.setItem(this.key(identity), JSON.stringify(parseMetadata(metadata)));
  }

  async remove(identity: WorkspaceMetadataIdentity): Promise<void> {
    this.storage.removeItem(this.key(identity));
  }

  private key(identity: WorkspaceMetadataIdentity): string {
    return `${this.namespace}.${workspaceMetadataKey(identity)}`;
  }
}

export function workspaceMetadataKey(identity: WorkspaceMetadataIdentity): string {
  const environmentId = normalizeIdentityPart(identity.environmentId, "environmentId");
  const serverId = identity.serverId === undefined
    ? "environment"
    : normalizeIdentityPart(identity.serverId, "serverId");
  return `${encodeKeyPart(environmentId)}.${encodeKeyPart(serverId)}`;
}

export function createEmptyWorkspaceMetadata(): WorkspaceMetadata {
  return {
    schemaVersion: WORKSPACE_METADATA_SCHEMA_VERSION,
    migrationVersion: 0,
    openRepositoryIds: [],
    recentRepositories: [],
    activeRepositoryId: null,
  };
}

function parseMetadata(value: unknown): WorkspaceMetadata {
  if (!isRecord(value)) throw new TypeError("Invalid workspace metadata");
  if (
    value.schemaVersion !== WORKSPACE_METADATA_SCHEMA_VERSION
    || typeof value.migrationVersion !== "number"
    || !Number.isInteger(value.migrationVersion)
    || value.migrationVersion < 0
  ) {
    throw new TypeError("Unsupported workspace metadata version");
  }
  if (!Array.isArray(value.openRepositoryIds) || !value.openRepositoryIds.every(isRepositoryId)) {
    throw new TypeError("Invalid open repository metadata");
  }
  if (!Array.isArray(value.recentRepositories) || !value.recentRepositories.every(isRecentMetadata)) {
    throw new TypeError("Invalid recent repository metadata");
  }
  if (value.activeRepositoryId !== null && !isRepositoryId(value.activeRepositoryId)) {
    throw new TypeError("Invalid active repository metadata");
  }

  const recentRepositories: WorkspaceRecentMetadata[] = [];
  const recentIds = new Set<string>();
  for (const recent of value.recentRepositories) {
    if (!recentIds.has(recent.repositoryId)) {
      recentIds.add(recent.repositoryId);
      recentRepositories.push({ ...recent });
    }
  }

  return {
    schemaVersion: value.schemaVersion,
    migrationVersion: value.migrationVersion,
    openRepositoryIds: [...new Set(value.openRepositoryIds)],
    recentRepositories,
    activeRepositoryId: value.activeRepositoryId,
  };
}

function cloneMetadata(metadata: WorkspaceMetadata): WorkspaceMetadata {
  return parseMetadata(metadata);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRepositoryId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isRecentMetadata(value: unknown): value is WorkspaceRecentMetadata {
  return isRecord(value)
    && isRepositoryId(value.repositoryId)
    && typeof value.lastOpenedAt === "number"
    && Number.isFinite(value.lastOpenedAt)
    && typeof value.order === "number"
    && Number.isInteger(value.order)
    && value.order >= 0;
}

function normalizeIdentityPart(value: string, field: string): string {
  if (
    typeof value !== "string"
    || !value.trim()
    || value !== value.trim()
    || value.length > 512
    || /[\u0000-\u001f\u007f]/.test(value)
  ) throw new TypeError(`Invalid ${field}`);
  return value;
}

function encodeKeyPart(value: string): string {
  // Hex-encode UTF-16 code units so the `.` separator can never collide with
  // identity data and no lossy replacement is needed.
  return value
    .split("")
    .map((character) => character.charCodeAt(0).toString(16).padStart(4, "0"))
    .join("");
}
