import { describe, expect, it } from "vitest";
import type { StashInfo } from "../types/repository";
import { captureStashActionContext, reconcileSelectedStash, stashContextPaths } from "./stash-selection";

const stash: StashInfo = {
  hash: "a".repeat(40), selector: "stash@{0}", baseHash: "b".repeat(40),
  indexHash: null, branch: "main", message: "Saved changes", timestamp: 1,
};

describe("stash selection identity", () => {
  it("copies repository/environment and reviewed target before a dialog can outlive selection", () => {
    const entry = { ...stash };
    const captured = captureStashActionContext("environment-a", "repo-a", entry);
    entry.selector = "stash@{1}";
    entry.hash = "c".repeat(40);
    expect(captured).toEqual({
      environmentId: "environment-a", repositoryId: "repo-a",
      target: { selector: stash.selector, expectedOid: stash.hash },
    });
    expect(captureStashActionContext("environment-b", "repo-a", stash).environmentId).not.toBe(captured.environmentId);
  });

  it("keeps updated metadata only for the same reviewed entry", () => {
    const updated = { ...stash, message: "Updated metadata" };
    expect(reconcileSelectedStash(stash, [updated])).toBe(updated);
  });

  it("clears on removal, replacement, or reindex without choosing the next stash", () => {
    expect(reconcileSelectedStash(stash, [])).toBeNull();
    expect(reconcileSelectedStash(stash, [{ ...stash, hash: "c".repeat(40) }])).toBeNull();
    expect(reconcileSelectedStash(stash, [{ ...stash, selector: "stash@{1}" }])).toBeNull();
    expect(reconcileSelectedStash(stash, [
      { ...stash, hash: "c".repeat(40) }, { ...stash, selector: "stash@{1}" },
    ])).toBeNull();
  });
});

describe("stash staging-section context", () => {
  it("uses selected paths only when the clicked file belongs to that section's selection", () => {
    expect(stashContextPaths("one", ["one", "two", "one"])).toEqual(["one", "two"]);
    expect(stashContextPaths("outside", ["one", "two"])).toEqual(["outside"]);
    expect(stashContextPaths("one", [])).toEqual(["one"]);
  });

  it("copies the selection and preserves literal unusual paths", () => {
    const paths = [" leading space ", "-option", ":(glob)*", "line\nbreak"];
    const captured = stashContextPaths(paths[0], paths);
    paths.length = 0;
    expect(captured).toEqual([" leading space ", "-option", ":(glob)*", "line\nbreak"]);
  });
});
