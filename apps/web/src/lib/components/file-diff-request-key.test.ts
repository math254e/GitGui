import { describe, expect, it } from "vitest";
import type { CommitFile, RepositorySnapshot } from "$lib/types/repository";
import { buildFileDiffRequestKey, buildFileDiffSelectionKey } from "./file-diff-request-key";

const snapshot = { status: { headOid: "head" } } as RepositorySnapshot;
const file = { path: "src/open.ts", status: " M" } as CommitFile;

describe("file diff request key", () => {
  it("changes when the selected file content revision changes", () => {
    const before = buildFileDiffRequestKey("repo", snapshot, "workingTree", null, file, 0);
    const after = buildFileDiffRequestKey("repo", snapshot, "workingTree", null, file, 1);
    expect(after).not.toBe(before);
  });

  it("does not change for an unrelated file revision", () => {
    const revisions: Record<string, number> = { "src/open.ts": 4 };
    const before = buildFileDiffRequestKey("repo", snapshot, "workingTree", null, file, revisions[file.path] ?? 0);
    revisions["src/other.ts"] = 1;
    const after = buildFileDiffRequestKey("repo", snapshot, "workingTree", null, file, revisions[file.path] ?? 0);
    expect(after).toBe(before);
  });

  it("does not invalidate immutable commit diffs for working-tree revisions", () => {
    const commit = { hash: "commit", parents: [] } as never;
    expect(buildFileDiffRequestKey("repo", snapshot, "commit", commit, file, 0))
      .toBe(buildFileDiffRequestKey("repo", snapshot, "commit", commit, file, 9));
  });

  it("keeps the same document selected when its status changes, and isolates paths and diff sources", () => {
    const selected = buildFileDiffSelectionKey("repo", "workingTree", null, file);
    expect(buildFileDiffSelectionKey("repo", "workingTree", null, { ...file, status: "MM" })).toBe(selected);
    expect(buildFileDiffSelectionKey("repo", "staged", null, file)).not.toBe(selected);
    expect(buildFileDiffSelectionKey("other-repo", "workingTree", null, file)).not.toBe(selected);
    expect(buildFileDiffSelectionKey("repo", "workingTree", null, { ...file, path: "other.ts" })).not.toBe(selected);
  });
});
