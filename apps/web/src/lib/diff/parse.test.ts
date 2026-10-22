import { describe, expect, it } from "vitest";
import { parseFileDiff } from "./parse";
import type { DiffParseRequest } from "./parse";

function request(overrides: Partial<DiffParseRequest> = {}): DiffParseRequest {
  return { originalPath: "src/code.ts", modifiedPath: "src/code.ts", originalContent: "old\n", modifiedContent: "new\n", cacheKey: "selection", ...overrides };
}

describe("worker diff parsing", () => {
  it("parses a large rewrite from Git without recomputing it and keeps the full files", () => {
    const lines = 100_000;
    const original = "const oldValue = 42;\n".repeat(lines);
    const modified = "const newValue = 42;\n".repeat(lines);
    const patch = `diff --git a/original b/modified\n--- a/original\n+++ b/modified\n@@ -1,${lines} +1,${lines} @@\n${"-const oldValue = 42;\n".repeat(lines)}${"+const newValue = 42;\n".repeat(lines)}`;
    const metadata = parseFileDiff(request({ originalContent: original, modifiedContent: modified, patch }));
    expect(metadata.isPartial).toBe(false);
    expect(metadata.name).toBe("src/code.ts");
    expect(metadata.deletionLines.join("")).toBe(original);
    expect(metadata.additionLines.join("")).toBe(modified);
    expect(metadata.hunks[0].additionCount).toBe(lines);
    expect(metadata.hunks[0].deletionCount).toBe(lines);
  });

  it("hydrates unchanged context in the worker for expanded layouts", () => {
    const original = Array.from({ length: 10_000 }, (_, i) => `const value${i} = 42;\n`).join("");
    const modified = original.replace("const value5000 = 42;", "const value5000 = 43;");
    const patch = "diff --git a/original b/modified\n--- a/original\n+++ b/modified\n@@ -5001 +5001 @@\n-const value5000 = 42;\n+const value5000 = 43;\n";
    const metadata = parseFileDiff(request({ originalContent: original, modifiedContent: modified, patch }));
    expect(metadata.isPartial).toBe(false);
    expect(metadata.deletionLines.join("")).toBe(original);
    expect(metadata.additionLines.join("")).toBe(modified);
    expect(metadata.hunks[0].additionStart).toBe(5001);
  });

  it("preserves long lines, CRLF, and a missing final newline", () => {
    const original = `${"x".repeat(32_768)}\r\nold`;
    const modified = `${"x".repeat(32_768)}\r\nnew`;
    const metadata = parseFileDiff(request({ originalContent: original, modifiedContent: modified }));
    expect(metadata.deletionLines.join("")).toBe(original);
    expect(metadata.additionLines.join("")).toBe(modified);
    expect(metadata.hunks[0].noEOFCRAdditions).toBe(true);
  });

  it("uses Git's normalized worktree patch with complete CRLF contents", () => {
    const originalContent = "const unchanged = 1;\nconst value = 1;\nconst tail = 1;\n";
    const modifiedContent = "const unchanged = 1;\r\nconst value = 2;\r\nconst tail = 1;\r\n";
    const patch = "diff --git a/code.ts b/code.ts\n--- a/code.ts\n+++ b/code.ts\n@@ -1,3 +1,3 @@\n const unchanged = 1;\n-const value = 1;\n+const value = 2;\n const tail = 1;\n";
    const metadata = parseFileDiff(request({ originalContent, modifiedContent, patch }));
    expect(metadata.isPartial).toBe(false);
    expect(metadata.additionLines.join("")).toBe(modifiedContent);
    expect(metadata.deletionLines.join("")).toBe(originalContent);
    expect(metadata.hunks[0].additionCount).toBe(3);
    expect(metadata.hunks[0].deletionCount).toBe(3);
    expect(metadata.hunks[0].hunkContent).toMatchObject([
      { type: "context", lines: 1 },
      { type: "change", deletions: 1, additions: 1 },
      { type: "context", lines: 1 },
    ]);
  });

  it("supports additions, deletions, renamed paths, and older servers without patches", () => {
    const added = parseFileDiff(request({ originalPath: null, originalContent: "" }));
    expect(added.type).toBe("new");
    expect(added.additionLines.join("")).toBe("new\n");
    const deleted = parseFileDiff(request({ modifiedContent: "" }));
    expect(deleted.deletionLines.join("")).toBe("old\n");
    expect(deleted.additionLines).toHaveLength(0);
    const renamed = parseFileDiff(request({ modifiedPath: "renamed ü [1].ts" }));
    expect(renamed.prevName).toBe("src/code.ts");
    expect(renamed.name).toBe("renamed ü [1].ts");
    expect(renamed.cacheKey).toBe("selection");
  });

  it("keeps Git's added and deleted hunk coordinates with complete contents", () => {
    const added = parseFileDiff(request({ originalPath: null, originalContent: "", patch: "diff --git a/file b/file\nnew file mode 100644\n--- /dev/null\n+++ b/file\n@@ -0,0 +1 @@\n+new\n" }));
    expect(added.type).toBe("new");
    expect(added.hunks[0].additionStart).toBe(1);
    expect(added.additionLines.join("")).toBe("new\n");
    const deleted = parseFileDiff(request({ modifiedContent: "", patch: "diff --git a/file b/file\ndeleted file mode 100644\n--- a/file\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n" }));
    expect(deleted.type).toBe("deleted");
    expect(deleted.hunks[0].deletionStart).toBe(1);
    expect(deleted.deletionLines.join("")).toBe("old\n");
    expect(deleted.additionLines).toHaveLength(0);
  });
});
