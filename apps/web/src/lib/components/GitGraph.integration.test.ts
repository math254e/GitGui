// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import type { RepositorySnapshot } from "@gitgui/contracts";
import GitGraph from "./GitGraph.svelte";

const menu = vi.hoisted(() => ({ show: vi.fn(async (..._args: unknown[]) => "continue"), dismiss: vi.fn() }));
vi.mock("$lib/contextMenu", () => ({ showContextMenu: menu.show, dismissContextMenu: menu.dismiss }));
vi.mock("@lucide/svelte", () => ({ Cloud: () => {}, Monitor: () => {}, Tag: () => {} }));

let component: ReturnType<typeof mount> | undefined;
afterEach(async () => { if (component) await unmount(component); component = undefined; document.body.replaceChildren(); vi.clearAllMocks(); });

describe("integration recovery in the graph", () => {
  it("offers direct rebase onto a commit without a branch", async () => {
    const hash = "a".repeat(40);
    const commit = { hash, parents: [], author: "Author", timestamp: 1, message: "Older commit" };
    const snapshot: RepositorySnapshot = {
      info: { path: "/repo", root: "/repo" },
      status: { currentBranch: "main", headOid: "b".repeat(40), ahead: 0, behind: 0, changedFiles: [] },
      commits: [commit], refs: [], stashes: [], worktrees: [],
      graph: { commits: [{ hash, row: 0, lane: 0 }], edges: [], headLane: 0, width: 1 },
    };
    const onRebaseCommit = vi.fn();
    menu.show.mockResolvedValueOnce("rebase-commit");
    component = mount(GitGraph, { target: document.body, props: {
      snapshot, repositoryId: "repo", getRestoredScrollTop: () => 0, selectedCommit: null,
      changesSelected: false, scrollToCommit: null, onScrollTopChange: vi.fn(), onScrollCommandHandled: vi.fn(),
      onSelectChanges: vi.fn(), onSelectCommit: vi.fn(), onCompareCommitToWorkingTree: vi.fn(), canIntegrate: true, canRebase: true, onRebaseCommit,
    } });
    flushSync();
    document.querySelector<HTMLButtonElement>(`[data-commit-hash="${hash}"]`)!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(onRebaseCommit).toHaveBeenCalledWith(commit));
  });

  it("puts branch actions directly in the commit menu with a heading for each target", async () => {
    const hash = "a".repeat(40);
    const commit = { hash, parents: [], author: "Author", timestamp: 1, message: "Commit" };
    const snapshot: RepositorySnapshot = {
      info: { path: "/repo", root: "/repo" },
      status: { currentBranch: "main", headOid: "b".repeat(40), ahead: 0, behind: 0, changedFiles: [] },
      commits: [commit], refs: [
        { name: "refs/heads/main", shortName: "main", refType: "localBranch", target: hash },
        { name: "refs/heads/topic", shortName: "topic", refType: "localBranch", target: hash },
      ], stashes: [], worktrees: [], graph: { commits: [{ hash, row: 0, lane: 0 }], edges: [], headLane: 0, width: 1 },
    };
    const onRebaseCommit = vi.fn();
    menu.show.mockResolvedValueOnce("rebase-commit");
    component = mount(GitGraph, { target: document.body, props: {
      snapshot, repositoryId: "repo", getRestoredScrollTop: () => 0, selectedCommit: null,
      changesSelected: false, scrollToCommit: null, onScrollTopChange: vi.fn(), onScrollCommandHandled: vi.fn(),
      onSelectChanges: vi.fn(), onSelectCommit: vi.fn(), onCompareCommitToWorkingTree: vi.fn(),
      canIntegrate: true, canRebase: true, onRebaseCommit,
    } });
    flushSync();
    const row = document.querySelector<HTMLButtonElement>(`[data-commit-hash="${hash}"]`);
    expect(row).not.toBeNull();
    row!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(onRebaseCommit).toHaveBeenCalledWith(commit));
    const items = menu.show.mock.calls[0][0] as Array<{ id: string; header?: boolean; children?: unknown }>;
    expect(items.find((item) => item.id === "branch-heading:refs/heads/main")?.header).toBe(true);
    expect(items.find((item) => item.id === "branch-heading:refs/heads/topic")?.header).toBe(true);
    expect(items.find((item) => item.id === "rebase-commit")).toMatchObject({ label: "Rebase current branch onto this commit", disabled: false });
    expect(items.some((item) => item.id === "rebase:refs/heads/topic")).toBe(false);
    expect(items.some((item) => item.children)).toBe(false);
  });

  it("keeps a keyboard-accessible rebase context menu even with a clean detached worktree", async () => {
    const snapshot: RepositorySnapshot = {
      info: { path: "/repo", root: "/repo" },
      status: { currentBranch: null, headOid: "a".repeat(40), ahead: 0, behind: 0, changedFiles: [] },
      commits: [], refs: [], stashes: [], worktrees: [], graph: { commits: [], edges: [], headLane: null, width: 1 },
    };
    const onRecovery = vi.fn();
    component = mount(GitGraph, { target: document.body, props: {
      snapshot, repositoryId: "repo", getRestoredScrollTop: () => 0, selectedCommit: null,
      changesSelected: false, scrollToCommit: null, onScrollTopChange: vi.fn(), onScrollCommandHandled: vi.fn(),
      onSelectChanges: vi.fn(), onSelectCommit: vi.fn(), onCompareCommitToWorkingTree: vi.fn(),
      integrationState: { kind: "rebase", unresolvedPaths: [] }, canRecoverIntegration: true,
      onIntegrationRecovery: onRecovery,
    } });
    flushSync();
    const row = document.querySelector<HTMLButtonElement>("[data-working-tree]");
    expect(row?.textContent).toContain("Rebase in progress");
    row!.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }));
    await vi.waitFor(() => expect(onRecovery).toHaveBeenCalledWith("continue"));
    expect((menu.show.mock.calls[0][0] as Array<{ id: string }>).map((item) => item.id)).toEqual(["continue", "skip", "abort"]);
  });
});
