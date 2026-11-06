import type { RepositorySummary } from "@gitgui/contracts";

const PREFIX = "gitgui.repositoryCatalog.v1.";
const MAX_CACHE_LENGTH = 8 * 1024 * 1024;
const MAX_REPOSITORIES = 10_000;

/** Non-secret, environment-owned summaries; never credentials or Git output. */
export class RepositoryCatalogCache {
  constructor(private readonly storage: Storage) {}

  load(environmentId: string): RepositorySummary[] | null {
    try {
      const raw = this.storage.getItem(this.key(environmentId));
      if (!raw || raw.length > MAX_CACHE_LENGTH) return null;
      const value: unknown = JSON.parse(raw);
      if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.repositories) || value.repositories.length > MAX_REPOSITORIES) return null;
      const repositories = value.repositories.map(readSummary);
      return repositories.every((repository) => repository !== null) ? repositories as RepositorySummary[] : null;
    } catch {
      return null;
    }
  }

  save(environmentId: string, repositories: readonly RepositorySummary[]): void {
    try {
      if (repositories.length > MAX_REPOSITORIES) return;
      const summaries = repositories.map(readSummary);
      if (summaries.some((summary) => summary === null)) return;
      const raw = JSON.stringify({ version: 1, repositories: summaries });
      if (raw.length <= MAX_CACHE_LENGTH) this.storage.setItem(this.key(environmentId), raw);
    } catch {
      // Cache persistence is optional; it must not fail an active session.
    }
  }

  remove(environmentId: string): void {
    this.storage.removeItem(this.key(environmentId));
  }

  private key(environmentId: string): string {
    return PREFIX + encodeURIComponent(environmentId);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSummary(value: unknown): RepositorySummary | null {
  if (!isRecord(value)) return null;
  const { id, name, root, path, isWorktree, missing, metadataStale, repositoryIdentity, worktreeFamily } = value;
  if (![id, name, root, path].every((part) => typeof part === "string" && part.length > 0 && part.length <= 32_768)
      || typeof isWorktree !== "boolean" || (missing !== undefined && typeof missing !== "boolean")
      || (metadataStale !== undefined && typeof metadataStale !== "boolean")) return null;
  if (repositoryIdentity !== undefined && (!isRecord(repositoryIdentity) || typeof repositoryIdentity.canonicalKey !== "string"
    || repositoryIdentity.canonicalKey.length === 0 || repositoryIdentity.canonicalKey.length > 4096
    || /[\s@?#]/.test(repositoryIdentity.canonicalKey) || repositoryIdentity.canonicalKey.includes("://"))) return null;
  if (worktreeFamily !== undefined && (!isRecord(worktreeFamily) || typeof worktreeFamily.id !== "string"
    || !worktreeFamily.id || worktreeFamily.id.length > 512
    || (worktreeFamily.mainRoot !== undefined && (typeof worktreeFamily.mainRoot !== "string" || !worktreeFamily.mainRoot || worktreeFamily.mainRoot.length > 32_768)))) return null;
  return {
    id: id as string, name: name as string, root: root as string, path: path as string, isWorktree,
    ...(missing === undefined ? {} : { missing }),
    ...(metadataStale === undefined ? {} : { metadataStale }),
    ...(repositoryIdentity === undefined ? {} : { repositoryIdentity: { canonicalKey: (repositoryIdentity as { canonicalKey: string }).canonicalKey } }),
    ...(worktreeFamily === undefined ? {} : { worktreeFamily: { id: (worktreeFamily as { id: string }).id,
      ...((worktreeFamily as { mainRoot?: string }).mainRoot === undefined ? {} : { mainRoot: (worktreeFamily as { mainRoot: string }).mainRoot }) } }),
  };
}
