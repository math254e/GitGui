import { describe, expect, it, vi } from "vitest";
import { ApplicationWorkspaceMetadataAdapter, createApplicationWorkspaceCoordinator } from "./application-workspace-metadata";
import { LocalStorageWorkspaceMetadataAdapter } from "./metadata";

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; }, clear: () => values.clear(), key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

describe("application workspace metadata", () => {
  it("migrates legacy primary tabs even before that environment registers", async () => {
    const backing = storage();
    const old = new LocalStorageWorkspaceMetadataAdapter(backing);
    await old.save({ environmentId: "late-primary" }, { schemaVersion: 1, openRepositoryIds: ["repo"], activeRepositoryId: "repo", recentRepositories: [] });
    const adapter = new ApplicationWorkspaceMetadataAdapter(backing);
    const result = await adapter.loadOrMigrate([], "late-primary", () => "tab");
    expect(result.tabs).toEqual([{ tabId: "tab", target: { environmentId: "late-primary", repositoryId: "repo" } }]);
    expect(result.activeTabId).toBe("tab");
  });
  it("retains tabs for environments whose registrations arrive later", async () => {
    const backing = storage();
    const adapter = new ApplicationWorkspaceMetadataAdapter(backing);
    adapter.save({ tabs: [
      { tabId: "a", target: { environmentId: "a", repositoryId: "one" } },
      { tabId: "b", target: { environmentId: "b", repositoryId: "one" } },
    ], activeTabId: "a" });
    const coordinator = await createApplicationWorkspaceCoordinator(backing, ["b"]);
    expect(coordinator.state.activeTabId).toBe("a");
    expect(coordinator.state.tabs.map((tab) => tab.tabId)).toEqual(["a", "b"]);
    expect(adapter.load()).toEqual(coordinator.state);
  });
  it("migrates tabs from all environments while preserving old records and scoped duplicates", async () => {
    const backing = storage();
    const old = new LocalStorageWorkspaceMetadataAdapter(backing);
    await old.save({ environmentId: "a" }, { schemaVersion: 1, openRepositoryIds: ["one", "two"], activeRepositoryId: "one", recentRepositories: [] });
    await old.save({ environmentId: "b" }, { schemaVersion: 1, openRepositoryIds: ["one"], activeRepositoryId: "one", recentRepositories: [] });
    let id = 0;
    const adapter = new ApplicationWorkspaceMetadataAdapter(backing);
    const result = await adapter.loadOrMigrate(["a", "b"], "b", () => `tab-${++id}`);
    expect(result.tabs.map((tab) => tab.target)).toEqual([
      { environmentId: "b", repositoryId: "one" },
      { environmentId: "a", repositoryId: "one" },
      { environmentId: "a", repositoryId: "two" },
    ]);
    expect(result.activeTabId).toBe("tab-1");
    expect(await old.load({ environmentId: "a" })).not.toBeNull();
    expect(await adapter.loadOrMigrate(["a"], "a", () => { throw new Error("must not migrate twice"); })).toEqual(result);
  });

  it("does not overwrite corrupted new state or discard legacy data on write failure", async () => {
    const backing = storage();
    const old = new LocalStorageWorkspaceMetadataAdapter(backing);
    await old.save({ environmentId: "a" }, { schemaVersion: 1, openRepositoryIds: ["one"], activeRepositoryId: "one", recentRepositories: [] });
    const adapter = new ApplicationWorkspaceMetadataAdapter(backing);
    backing.setItem("gitgui.applicationWorkspace.v1", "{broken");
    await expect(adapter.loadOrMigrate(["a"], "a")).rejects.toThrow();
    expect(backing.getItem("gitgui.applicationWorkspace.v1")).toBe("{broken");
    backing.removeItem("gitgui.applicationWorkspace.v1");
    vi.spyOn(backing, "setItem").mockImplementation(() => { throw new Error("quota"); });
    await expect(adapter.loadOrMigrate(["a"], "a", () => "tab")).rejects.toThrow("quota");
    expect(await old.load({ environmentId: "a" })).not.toBeNull();
  });

  it("migrates unselected environments in stable order regardless of registration order", async () => {
    const backing = storage();
    const old = new LocalStorageWorkspaceMetadataAdapter(backing);
    for (const environmentId of ["c", "a", "b"]) {
      await old.save({ environmentId }, { schemaVersion: 1, openRepositoryIds: ["same"], activeRepositoryId: "same", recentRepositories: [] });
    }
    let id = 0;
    const result = await new ApplicationWorkspaceMetadataAdapter(backing).loadOrMigrate(["c", "a", "b"], "b", () => `tab-${++id}`);
    expect(result.tabs.map((tab) => tab.target.environmentId)).toEqual(["b", "a", "c"]);
  });
});
