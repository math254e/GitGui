import { describe, expect, it, vi } from "vitest";
import { RepositoryCatalogCache } from "./repository-catalog-cache";

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(), key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

describe("repository catalog cache", () => {
  it("keeps environment caches independent and stores only summary fields", () => {
    const cache = new RepositoryCatalogCache(storage());
    const summary = { id: "repo", name: "Repo", path: "/repo", root: "/repo", isWorktree: false, missing: true, metadataStale: true, secret: "ignored", repositoryIdentity: { canonicalKey: "github.com/team/repo" }, worktreeFamily: { id: "family", mainRoot: "/repo" } };
    cache.save("one", [summary]);
    cache.save("two", []);
    expect(cache.load("one")).toEqual([{ id: "repo", name: "Repo", path: "/repo", root: "/repo", isWorktree: false, missing: true, metadataStale: true, repositoryIdentity: summary.repositoryIdentity, worktreeFamily: summary.worktreeFamily }]);
    cache.remove("one");
    expect(cache.load("one")).toBeNull();
    expect(cache.load("two")).toEqual([]);
  });

  it("treats corrupt or inaccessible storage as an unavailable cache", () => {
    const backing = storage();
    backing.setItem("gitgui.repositoryCatalog.v1.one", '{"version":1,"repositories":[{}]}');
    const cache = new RepositoryCatalogCache(backing);
    expect(cache.load("one")).toBeNull();
    vi.spyOn(backing, "setItem").mockImplementation(() => { throw new Error("quota"); });
    expect(() => cache.save("one", [])).not.toThrow();
  });
});
