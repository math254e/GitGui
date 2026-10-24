import { describe, expect, it } from "vitest";
import type { GitGuiClient } from "@gitgui/client-runtime";
import { StashFilesCache, stashFilesCache } from "./stash-files-cache";

const file = { path: "src/one", originalPath: "src/old", status: "R100" };

describe("stash files presentation cache", () => {
  it("isolates clients, repositories and immutable stash identities", () => {
    const client = {} as GitGuiClient, other = {} as GitGuiClient;
    const cache = stashFilesCache(client);
    cache.put("repo", "oid", [file]);
    expect(stashFilesCache(client)).toBe(cache);
    expect(cache.get("repo", "oid")).toEqual([file]);
    expect(cache.get("other", "oid")).toBeUndefined();
    expect(cache.get("repo", "other")).toBeUndefined();
    expect(stashFilesCache(other).get("repo", "oid")).toBeUndefined();
  });

  it("reuses equal arrays, snapshots response records, and supports invalidation", () => {
    const cache = new StashFilesCache();
    const incoming = [{ ...file }];
    const saved = cache.put("repo", "oid", incoming);
    incoming[0].path = "mutated";
    expect(saved[0].path).toBe(file.path);
    expect(cache.put("repo", "oid", [{ ...file }])).toBe(saved);
    expect(cache.put("repo", "oid", [{ ...file, status: "M" }])).not.toBe(saved);
    cache.delete("repo", "oid");
    expect(cache.get("repo", "oid")).toBeUndefined();
    // Empty successful lists are also cached, rather than becoming misses.
    const empty = cache.put("repo", "oid", []);
    expect(cache.get("repo", "oid")).toBe(empty);
  });

  it("bounds entries with LRU retention and includes rename paths in the byte budget", () => {
    const cache = new StashFilesCache(2, 1024);
    cache.put("repo", "one", [file]); cache.put("repo", "two", [file]);
    cache.get("repo", "one"); cache.put("repo", "three", [file]);
    expect(cache.get("repo", "two")).toBeUndefined();
    expect(cache.get("repo", "one")).toBeDefined();
    cache.put("repo", "huge", [{ ...file, originalPath: "x".repeat(1024) }]);
    expect(cache.get("repo", "huge")).toBeUndefined();
    expect(cache.get("repo", "one")).toBeDefined();
    const bytes = new StashFilesCache(32, 500);
    bytes.put("repo", "one", [file]); bytes.put("repo", "two", [file]);
    expect(bytes.get("repo", "one")).toBeUndefined();
    expect(bytes.get("repo", "two")).toBeDefined();
  });
});
