// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import type { CommitFileDiff, CommitInfo, GitHunkPreview, RepositorySnapshot } from "@gitgui/contracts";
import Harness from "./Component.test-harness.svelte";
import CommitDetailsPanel from "./CommitDetailsPanel.svelte";
import CommitFileDiffViewer from "./CommitFileDiffViewer.svelte";

vi.mock("@lucide/svelte", () => ({ CalendarDays: () => {}, FilePenLine: () => {}, GitBranch: () => {}, GitCommitHorizontal: () => {}, Minus: () => {}, Pencil: () => {}, Plus: () => {}, UserRound: () => {}, X: () => {} }));
vi.mock("@pierre/trees", () => ({ FileTree: class { render() {} setOptions() {} setSelectedPaths() {} cleanUp() {} } }));
vi.mock("$lib/theme/useTheme", () => ({ themeStore: {
  getSnapshot: () => ({ resolvedAppearance: "light" }), subscribe: () => () => {},
} }));
vi.mock("$lib/diff/parser", () => ({ parseDiffInWorker: vi.fn(async () => ({ durationMs: 0, metadata: {
  cacheKey: "parsed", hunks: [{ additionCount: 1, additionStart: 1, deletionCount: 1, deletionStart: 1 }],
} })) }));
vi.mock("$lib/diff/renderer", () => ({ acquireDiffRenderer: () => ({ release() {}, ready: Promise.resolve({
  workers: {}, library: {
    getLineAnnotationName: () => "hunk",
    CodeView: class {
      host!: HTMLElement;
      options!: { onPostRender: (node: HTMLElement) => void };
      setup(host: HTMLElement) { this.host = host; }
      setOptions(options: typeof this.options) { this.options = options; }
      setItems(items: Array<{ annotations?: unknown[] }>) {
        this.host.replaceChildren();
        if (items[0]?.annotations?.length) {
          const node = document.createElement("div");
          node.attachShadow({ mode: "open" }).innerHTML = '<slot name="hunk"></slot>';
          this.host.append(node);
          this.options.onPostRender(node);
        }
      }
      cleanUp() {}
    },
  },
}) }) }));

const commit: CommitInfo = { hash: "commit", parents: ["parent"], author: "A", timestamp: 0, message: "Selected commit" };
const snapshot: RepositorySnapshot = { info: { path: "/repo", root: "/repo" }, status: {
  currentBranch: "main", headOid: "commit", ahead: 0, behind: 0, changedFiles: [],
}, commits: [commit], refs: [], stashes: [], worktrees: [], graph: { commits: [], edges: [], headLane: null, width: 1 } };
const diff: CommitFileDiff = { originalPath: "file.ts", modifiedPath: "file.ts", originalContent: "old\n", modifiedContent: "new\n", patch: "patch", isBinary: false, message: null };
const preview: GitHunkPreview = { filePath: "file.ts", staged: false, revision: "review", patch: "patch", hunks: [{ id: 0, header: "@@ -1 +1 @@", patch: "patch" }], unavailableReason: null };
const deferred = <T,>() => {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
let component: { update(value: Record<string, unknown>): void } | undefined;
beforeEach(() => { vi.spyOn(console, "debug").mockImplementation(() => {}); });
afterEach(async () => { if (component) await unmount(component); component = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); });
const settle = async () => { await Promise.resolve(); flushSync(); };

describe("detail reads across stable-client session replacement", () => {
  it.each([false, true])("retries the same commit files after cancellation (working-tree comparison: %s)", async (comparisonWithWorkingTree) => {
    const read = vi.fn().mockRejectedValueOnce(new Error("request_cancelled")).mockResolvedValue({ files: [] });
    const client = { getCommitFiles: read, getCommitWorkingTreeFiles: read };
    component = mount(Harness, { target: document.body, props: { component: CommitDetailsPanel, initialProps: {
      client, repositoryId: "same", snapshot, selectedCommit: commit, selectedFile: null,
      environmentGeneration: 1, comparisonWithWorkingTree, onSelectFile() {},
    } } });
    flushSync();
    await vi.waitFor(() => { flushSync(); expect(document.body.textContent).toContain("request_cancelled"); });
    component.update({ environmentGeneration: 2 }); flushSync();
    await vi.waitFor(() => { flushSync(); expect(document.body.textContent).toContain("This commit does not list file changes"); });
    expect(read).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain("request_cancelled");
  });

  it("ignores late commit-file failures from the replaced session", async () => {
    const old = deferred<{ files: [] }>();
    const read = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue({ files: [] });
    component = mount(Harness, { target: document.body, props: { component: CommitDetailsPanel, initialProps: {
      client: { getCommitFiles: read }, repositoryId: "same", snapshot, selectedCommit: commit, selectedFile: null,
      environmentGeneration: 1, onSelectFile() {},
    } } });
    flushSync();
    component.update({ environmentGeneration: 2 }); flushSync(); await settle();
    old.reject(new Error("stale session")); await settle(); await settle();
    expect(read).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain("stale session");
    expect(document.body.textContent).toContain("This commit does not list file changes");
  });

  it("retries the same file after cancellation and ignores a late old-session result", async () => {
    const old = deferred<{ diff: CommitFileDiff }>();
    const read = vi.fn().mockRejectedValueOnce(new Error("request_cancelled"))
      .mockReturnValueOnce(old.promise).mockResolvedValue({ diff });
    component = mount(Harness, { target: document.body, props: { component: CommitFileDiffViewer, initialProps: {
      client: { serverWelcome: { environment_id: "a" }, getCommitFileDiff: read }, repositoryId: "same", snapshot,
      diffSource: "commit", selectedCommit: commit, selectedFile: { path: "file.ts", status: "M" }, environmentGeneration: 1, onClose() {},
    } } });
    flushSync();
    await vi.waitFor(() => { flushSync(); expect(document.body.textContent).toContain("request_cancelled"); });
    component.update({ environmentGeneration: 2 }); flushSync();
    const oldSignal = read.mock.calls[1][1] as AbortSignal;
    component.update({ environmentGeneration: 3 }); flushSync();
    await vi.waitFor(() => { flushSync(); expect(read).toHaveBeenCalledTimes(3); expect(document.body.textContent).not.toContain("Loading file"); });
    expect(oldSignal.aborted).toBe(true);
    old.resolve({ diff: { ...diff, isBinary: true, message: "stale binary" } }); await settle(); await settle();
    expect(document.body.textContent).not.toContain("request_cancelled");
    expect(document.body.textContent).not.toContain("stale binary");
    expect(document.querySelector('[aria-label="Diff layout"]')).toBeTruthy();
  });

  it("invalidates old hunk controls until the replacement session reviews identical text", async () => {
    const nextReview = deferred<GitHunkPreview>();
    const review = vi.fn().mockResolvedValueOnce(preview).mockReturnValueOnce(nextReview.promise);
    const apply = vi.fn();
    component = mount(Harness, { target: document.body, props: { component: CommitFileDiffViewer, initialProps: {
      client: { serverWelcome: { environment_id: "a" }, getWorkingTreeFileDiff: vi.fn(async () => ({ diff })), getHunkPreview: review },
      repositoryId: "same", snapshot, diffSource: "workingTree", selectedCommit: null,
      selectedFile: { path: "file.ts", status: "M" }, environmentGeneration: 1, onClose() {}, onApplyHunks: apply,
    } } });
    flushSync();
    await vi.waitFor(() => { flushSync(); expect(document.querySelector<HTMLButtonElement>('[aria-label="Stage hunk 1"]')?.disabled).toBe(false); });
    const oldAction = document.querySelector<HTMLButtonElement>('[aria-label="Stage hunk 1"]')!;
    const checkbox = document.querySelector<HTMLInputElement>('[aria-label="Select hunk 1"]')!;
    checkbox.checked = true; checkbox.dispatchEvent(new Event("change")); flushSync();
    expect(document.body.textContent).toContain("1 hunk selected");
    component.update({ environmentGeneration: 2 }); flushSync();
    oldAction.click();
    expect(apply).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("1 hunk selected");
    await vi.waitFor(() => expect(review).toHaveBeenCalledTimes(2));
    nextReview.resolve({ ...preview, revision: "replacement-review" });
    await vi.waitFor(() => { flushSync(); expect(document.querySelector<HTMLButtonElement>('[aria-label="Stage hunk 1"]')?.disabled).toBe(false); });
    oldAction.click(); expect(apply).not.toHaveBeenCalled();
    document.querySelector<HTMLButtonElement>('[aria-label="Stage hunk 1"]')!.click();
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ revision: "replacement-review", repositoryId: "same", hunkIds: [0] }));
  });
});
