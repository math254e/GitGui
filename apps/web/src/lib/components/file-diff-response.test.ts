import { describe, expect, it } from "vitest";
import type { CommitFileDiff, GitHunkPreview } from "@gitgui/contracts";
import { hasCurrentHunkReview, resolveFileDiffPatch, reuseFileDiff, reuseHunkPreview } from "./file-diff-response";

const diff: CommitFileDiff = { originalPath: "file.ts", modifiedPath: "file.ts", originalContent: "old\n", modifiedContent: "new\n", isBinary: false, message: null, patch: "patch" };
const preview: GitHunkPreview = { filePath: "file.ts", staged: false, revision: "revision", patch: "patch", hunks: [{ id: 0, header: "@@ -1 +1 @@", patch: "-old\n+new\n" }], unavailableReason: null };

describe("file response revalidation", () => {
  it("waits for a working-file review instead of displaying a provisional snapshot patch", () => {
    const snapshot = { ...diff, patch: "full CRLF rewrite" };
    const review = { ...preview, patch: "Git-normalized edit" };
    expect(resolveFileDiffPatch(snapshot, null, true, "")).toBeNull();
    expect(resolveFileDiffPatch(snapshot, review, true, "")).toEqual({ patch: "Git-normalized edit" });
  });

  it("keeps commit patches immediate and permits fallback only after a review failure or unavailability", () => {
    expect(resolveFileDiffPatch(diff, null, false, "")).toEqual({ patch: diff.patch });
    expect(resolveFileDiffPatch(diff, null, true, "Review failed")).toEqual({ patch: diff.patch });
    expect(resolveFileDiffPatch(diff, { ...preview, unavailableReason: "Resolve conflicts" }, true, ""))
      .toEqual({ patch: diff.patch });
    expect(resolveFileDiffPatch({ ...diff, patch: undefined }, null, true, "Review failed"))
      .toEqual({ patch: undefined });
  });

  it("retains parsed/highlighted state when a refresh returns identical text", () => {
    expect(reuseFileDiff(diff, { ...diff })).toBe(diff);
    expect(reuseHunkPreview(preview, structuredClone(preview))).toBe(preview);
  });

  it("replaces contents and patches when an edit, index change, or comparison changes", () => {
    for (const next of [{ ...diff, originalContent: "new base\n" }, { ...diff, modifiedContent: "new edit\n" },
      { ...diff, patch: "different patch" }, { ...diff, originalPath: "renamed.ts" }, { ...diff, isBinary: true }]) {
      expect(reuseFileDiff(diff, next)).toBe(next);
    }
    expect(reuseFileDiff(null, diff)).toBe(diff);
  });

  it("replaces reviewed actions on new revisions and unavailable previews", () => {
    for (const next of [{ ...preview, revision: "new revision" }, { ...preview, patch: "new patch" },
      { ...preview, unavailableReason: "Resolve conflicts" }, { ...preview, staged: true }]) {
      expect(reuseHunkPreview(preview, next)).toBe(next);
    }
    expect(reuseHunkPreview(null, preview)).toBe(preview);
  });

  it("keeps an unchanged displayed review usable after background revalidation", () => {
    const parsed = { source: diff, preview };
    const refreshedDiff = reuseFileDiff(diff, structuredClone(diff));
    const refreshedPreview = reuseHunkPreview(preview, structuredClone(preview));
    expect(hasCurrentHunkReview(refreshedDiff, refreshedPreview, parsed, "file:1", "file:1")).toBe(true);
  });

  it("blocks a selected-file invalidation until a fresh review is accepted", () => {
    const parsed = { source: diff, preview };
    expect(hasCurrentHunkReview(diff, preview, parsed, "file:1", "file:2")).toBe(false);
    expect(hasCurrentHunkReview(diff, preview, parsed, "file:2", "file:2")).toBe(true);
    expect(hasCurrentHunkReview(diff, preview, parsed, "", "file:2")).toBe(false);
  });

  it("blocks replacement contents and reviewed patches until their displayed parse matches", () => {
    const parsed = { source: diff, preview };
    const changedDiff = { ...diff, modifiedContent: "edited" };
    const changedPreview = { ...preview, revision: "new revision" };
    expect(hasCurrentHunkReview(changedDiff, preview, parsed, "file:1", "file:1")).toBe(false);
    expect(hasCurrentHunkReview(diff, changedPreview, parsed, "file:1", "file:1")).toBe(false);
    expect(hasCurrentHunkReview(diff, null, parsed, "file:1", "file:1")).toBe(false);
    expect(hasCurrentHunkReview(diff, preview, null, "file:1", "file:1")).toBe(false);
    const unavailable = { ...preview, unavailableReason: "Resolve conflicts" };
    expect(hasCurrentHunkReview(diff, unavailable, { source: diff, preview: unavailable }, "file:1", "file:1")).toBe(false);
  });
});
