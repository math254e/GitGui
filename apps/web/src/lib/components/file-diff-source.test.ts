import { describe, expect, it, vi } from "vitest";
import type { GitGuiClient } from "@gitgui/client-runtime";
import type { CommitFileDiff, RepositorySnapshot, StashInfo } from "@gitgui/contracts";
import { canMutateFileDiff, requestFileDiff } from "./file-diff-source";
import { buildFileDiffRequestKey } from "./file-diff-request-key";
import { resolveFileDiffPatch } from "./file-diff-response";

const stash: StashInfo = { selector: "stash@{0}", hash: "oid", baseHash: "head", indexHash: null, message: "Saved", branch: "main", timestamp: 1 };
const file = { path: "literal\nfile", originalPath: null, status: "A" };
const snapshot = { status: { headOid: "head" } } as RepositorySnapshot;

describe("stash read-only diff source", () => {
  it("requests only the reviewed stash diff without a live-index continuation", async () => {
    const diff = { originalContent: "", modifiedContent: "saved", patch: "saved patch" } as CommitFileDiff;
    const client = { serverWelcome: { capabilities: ["git.stash.file_diff"] }, getStashFileDiff: vi.fn(async () => ({ diff })), getWorkingTreeFileDiff: vi.fn(), getHunkPreview: vi.fn() };
    const signal = new AbortController().signal;
    expect(await requestFileDiff(client as unknown as GitGuiClient, "repo", "stash", null, stash, file, snapshot, signal)).toEqual({ diff });
    expect(client.getStashFileDiff).toHaveBeenCalledWith({ repositoryId: "repo", target: { selector: "stash@{0}", expectedOid: "oid" }, filePath: "literal\nfile" }, signal);
    expect(client.getWorkingTreeFileDiff).not.toHaveBeenCalled();
    expect(client.getHunkPreview).not.toHaveBeenCalled();
    expect(canMutateFileDiff("stash")).toBe(false);
    // Hunks/Inline/Split can parse the saved patch immediately, without waiting
    // for a mutable working-tree review or manufacturing stage controls.
    expect(resolveFileDiffPatch(diff, null, canMutateFileDiff("stash"), "")).toEqual({ patch: "saved patch" });
    expect(canMutateFileDiff("commit")).toBe(false);
    expect(canMutateFileDiff("staged")).toBe(true);
    expect(canMutateFileDiff("workingTree")).toBe(true);
  });

  it("refuses an unsupported stash source without falling back to another read", async () => {
    const client = { serverWelcome: { capabilities: [] }, getStashFileDiff: vi.fn(), getWorkingTreeFileDiff: vi.fn() };
    await expect(requestFileDiff(client as unknown as GitGuiClient, "repo", "stash", null, stash, file, snapshot, new AbortController().signal)).rejects.toThrow("does not support");
    expect(client.getStashFileDiff).not.toHaveBeenCalled();
    expect(client.getWorkingTreeFileDiff).not.toHaveBeenCalled();
  });

  it("isolates immutable stash identities by selector, OID, repository, and environment", () => {
    const key = (entry = stash, env = "env", repo = "repo", revision = 0) => buildFileDiffRequestKey(repo, snapshot, "stash", null, file, revision, entry, env);
    expect(key()).toBe(key(stash, "env", "repo", 99));
    expect(key({ ...stash, selector: "stash@{1}" })).not.toBe(key());
    expect(key({ ...stash, hash: "replacement" })).not.toBe(key());
    expect(key(stash, "other-env")).not.toBe(key());
    expect(key(stash, "env", "other-repo")).not.toBe(key());
  });
});
