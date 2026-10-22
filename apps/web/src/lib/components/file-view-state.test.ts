import { describe, expect, it } from "vitest";
import type { CommitFileDiff } from "@gitgui/contracts";
import { fileViewState } from "./file-view-state";

const normal: CommitFileDiff = { originalPath: "file.txt", modifiedPath: "file.txt", originalContent: "old", modifiedContent: "new", isBinary: false, message: null };
const omitted: CommitFileDiff = { ...normal, originalContent: "", modifiedContent: "", omittedContent: { reason: "Too many lines", maxBytesPerSide: 65536, maxLinesPerSide: 500, maxLineBytes: 8192, originalPreview: "old", modifiedPreview: "new" } };

describe("file viewer response states", () => {
  it("finishes omitted loading without waiting for the renderer, even if its import failed", () => {
    expect(fileViewState(omitted, false, "", "", false)).toBe("omitted");
    expect(fileViewState(omitted, false, "", "import failed", false)).toBe("omitted");
  });
  it("shows loading when switching away from an omitted file and preserves RPC errors", () => {
    expect(fileViewState(null, true, "", "", true)).toBe("loading");
    expect(fileViewState(null, false, "Cannot read file", "", true)).toBe("error");
    expect(fileViewState(omitted, false, "Request failed", "", false)).toBe("error");
  });
  it("keeps normal parsing failures distinct from successful empty or binary responses", () => {
    expect(fileViewState(normal, false, "", "", false)).toBe("loading");
    expect(fileViewState(normal, false, "", "Parse failed", true)).toBe("error");
    expect(fileViewState(normal, false, "", "", true)).toBe("ready");
    expect(fileViewState({ ...normal, isBinary: true }, false, "", "", false)).toBe("binary");
    expect(fileViewState({ ...normal, originalContent: "", modifiedContent: "" }, false, "", "", true)).toBe("ready");
  });
});
