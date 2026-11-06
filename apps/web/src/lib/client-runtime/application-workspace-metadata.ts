import {
  scopedRepositoryKey,
  WorkspaceTabCoordinator,
  type RepositoryTab,
  type RepositoryTabs,
} from "@gitgui/client-runtime/workspace";
import { LocalStorageWorkspaceMetadataAdapter } from "./metadata";

const KEY = "gitgui.applicationWorkspace.v1";
const LIMIT = 10_000;

/** Write-ahead intent for removable registrations, separate from the tab writer.
 * Recovery checks authoritative persisted targets under the registry lease,
 * before deleting tabs or acknowledging intent. Primary discovery creates none.
 */
export class EnvironmentWorkspaceRemovalJournal {
  private readonly key = "gitgui.applicationWorkspace.removals.v1";
  constructor(private readonly storage: Storage) {}

  load(): string[] {
    const raw = this.storage.getItem(this.key);
    if (raw === null) return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length > LIMIT || !value.every(validId)) throw new TypeError("Invalid workspace removal journal");
    return [...new Set(value)];
  }

  begin(environmentId: string): void {
    if (!validId(environmentId)) throw new TypeError("Invalid environment ID");
    this.storage.setItem(this.key, JSON.stringify([...new Set([...this.load(), environmentId])]));
  }

  acknowledge(environmentId: string): void {
    const pending = this.load();
    if (!pending.includes(environmentId)) return;
    const remaining = pending.filter((id) => id !== environmentId);
    if (remaining.length) this.storage.setItem(this.key, JSON.stringify(remaining));
    else this.storage.removeItem(this.key);
  }
}

/** One client-owned tab order spanning all environments. */
export class ApplicationWorkspaceMetadataAdapter {
  constructor(private readonly storage: Storage) {}

  load(): RepositoryTabs | null {
    const raw = this.storage.getItem(KEY);
    if (raw === null) return null;
    if (raw.length > 8 * 1024 * 1024) throw new TypeError("Application workspace metadata is too large");
    // An invalid new record is an error, not permission to overwrite it with
    // legacy state. The caller can leave both copies untouched for recovery.
    return parseWorkspace(JSON.parse(raw));
  }

  save(state: RepositoryTabs): void {
    this.storage.setItem(KEY, JSON.stringify({ schemaVersion: 1, ...parseWorkspace({ schemaVersion: 1, ...state }) }));
  }

  /**
   * Call only after the registration catalog has hydrated. Legacy records are
   * intentionally retained; a failed write leaves them as the source of truth.
   */
  async loadOrMigrate(environmentIds: readonly string[], selectedEnvironmentId: string | undefined,
    makeTabId: () => string = () => crypto.randomUUID()): Promise<RepositoryTabs> {
    const existing = this.load();
    if (existing) return existing;
    // The primary server can register after startup. Read legacy metadata keys
    // as well as current registrations so its tabs are not omitted from the
    // one-time migration while the server is offline or still being discovered.
    const ordered = [...new Set([...environmentIds, ...legacyEnvironmentIds(this.storage)])].sort();
    const selectedIndex = selectedEnvironmentId ? ordered.indexOf(selectedEnvironmentId) : -1;
    if (selectedIndex > 0) ordered.unshift(...ordered.splice(selectedIndex, 1));
    const adapter = new LocalStorageWorkspaceMetadataAdapter(this.storage);
    const tabs: RepositoryTab[] = [];
    const seen = new Set<string>();
    let activeTabId: string | null = null;
    for (const environmentId of ordered) {
      const legacy = await adapter.load({ environmentId });
      if (!legacy) continue;
      for (const repositoryId of legacy.openRepositoryIds) {
        const key = scopedRepositoryKey({ environmentId, repositoryId });
        if (seen.has(key)) continue;
        seen.add(key);
        const tab = { tabId: makeTabId(), target: { environmentId, repositoryId } };
        tabs.push(tab);
        if (environmentId === selectedEnvironmentId && repositoryId === legacy.activeRepositoryId) activeTabId = tab.tabId;
      }
    }
    const migrated = { tabs, activeTabId: activeTabId ?? tabs[0]?.tabId ?? null };
    this.save(migrated);
    return migrated;
  }
}

function legacyEnvironmentIds(storage: Storage): string[] {
  const prefix = "gitgui.workspace.";
  const defaultServer = "0065006e007600690072006f006e006d0065006e0074";
  const ids: string[] = [];
  for (let index = 0; index < Math.min(storage.length, LIMIT); index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const parts = key.slice(prefix.length).split(".");
    if (parts.length !== 2 || parts[1] !== defaultServer || !parts[0] || parts[0].length % 4 !== 0 || !/^[0-9a-f]+$/.test(parts[0])) continue;
    const id = parts[0].replace(/.{4}/g, (unit) => String.fromCharCode(parseInt(unit, 16)));
    if (validId(id)) ids.push(id);
  }
  return ids;
}

/** Hydrate without treating an asynchronously discovered registration as removed. */
export async function createApplicationWorkspaceCoordinator(
  storage: Storage, environmentIds: readonly string[], selectedEnvironmentId?: string,
): Promise<WorkspaceTabCoordinator> {
  const adapter = new ApplicationWorkspaceMetadataAdapter(storage);
  const loaded = await adapter.loadOrMigrate(environmentIds, selectedEnvironmentId);
  // Registrations, especially the primary server, may arrive after startup.
  // Only an explicit, successfully persisted removal may remove its tabs.
  return new WorkspaceTabCoordinator(loaded, (state) => adapter.save(state));
}

function parseWorkspace(value: unknown): RepositoryTabs {
  if (!record(value) || value.schemaVersion !== 1 || !Array.isArray(value.tabs) || value.tabs.length > LIMIT) throw new TypeError("Invalid application workspace metadata");
  const ids = new Set<string>();
  const targets = new Set<string>();
  const tabs: RepositoryTab[] = value.tabs.map((tab: unknown) => {
    if (!record(tab) || !validId(tab.tabId) || !record(tab.target) || !validId(tab.target.environmentId) || !validId(tab.target.repositoryId)) throw new TypeError("Invalid application workspace tab");
    const target = { environmentId: tab.target.environmentId, repositoryId: tab.target.repositoryId };
    const key = scopedRepositoryKey(target);
    if (ids.has(tab.tabId) || targets.has(key)) throw new TypeError("Duplicate application workspace tab");
    ids.add(tab.tabId);
    targets.add(key);
    return { tabId: tab.tabId, target };
  });
  if (value.activeTabId !== null && (!validId(value.activeTabId) || !ids.has(value.activeTabId))) throw new TypeError("Invalid active application tab");
  return { tabs, activeTabId: value.activeTabId };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}
