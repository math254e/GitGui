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
  it.each(["checkout-commit", "checkout-branch:refs/remotes/origin/topic"])("routes %s to the selected graph target", async (action) => {
    const hash = "a".repeat(40);
    const commit = { hash, parents: [], author: "Author", timestamp: 1, message: "Commit" };
    const remote = { name: "refs/remotes/origin/topic", shortName: "origin/topic", refType: "remoteBranch" as const, target: hash };
    const snapshot: RepositorySnapshot = {
      info: { path: "/repo", root: "/repo" }, status: { currentBranch: "main", headOid: "b".repeat(40), ahead: 0, behind: 0, changedFiles: [] },
      commits: [commit], refs: [remote], stashes: [], worktrees: [], graph: { commits: [{ hash, row: 0, lane: 0 }], edges: [], headLane: 0, width: 1 },
    };
    const onCheckoutCommit = vi.fn(), onCheckoutRemoteBranch = vi.fn();
    menu.show.mockResolvedValueOnce(action);
    component = mount(GitGraph, { target: document.body, props: {
      snapshot, repositoryId: "repo", getRestoredScrollTop: () => 0, selectedCommit: null,
      changesSelected: false, scrollToCommit: null, onScrollTopChange: vi.fn(), onScrollCommandHandled: vi.fn(),
      onSelectChanges: vi.fn(), onSelectCommit: vi.fn(), onCompareCommitToWorkingTree: vi.fn(),
      canCheckoutCommit: true, canCheckoutRemoteBranch: true, onCheckoutCommit, onCheckoutRemoteBranch,
    } });
    flushSync();
    document.querySelector<HTMLButtonElement>(`[data-commit-hash="${hash}"]`)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    if (action === "checkout-commit") await vi.waitFor(() => expect(onCheckoutCommit).toHaveBeenCalledWith(commit));
    else await vi.waitFor(() => expect(onCheckoutRemoteBranch).toHaveBeenCalledWith(remote));
  });
  it.each([
    ["merge-commit", "merge"],
    ["rebase-commit", "rebase"],
    ["checkout-branch:refs/heads/topic", "checkout"],
    ["pull", "pull"],
    ["push", "push"],
  ] as const)("routes %s to the selected branch", async (menuAction, operation) => {
    const hash = "a".repeat(40);
    const commit = { hash, parents: [], author: "Author", timestamp: 1, message: "Commit" };
    const branch = { name: "refs/heads/topic", shortName: "topic", refType: "localBranch" as const, target: hash };
    const snapshot: RepositorySnapshot = {
      info: { path: "/repo", root: "/repo" },
      status: { currentBranch: "main", headOid: "b".repeat(40), ahead: 0, behind: 0, changedFiles: [] },
      commits: [commit], refs: [branch], stashes: [], worktrees: [],
      graph: { commits: [{ hash, row: 0, lane: 0 }], edges: [], headLane: 0, width: 1 },
    };
    const onIntegrateBranch = vi.fn(), onSwitchBranch = vi.fn(), onPullBranch = vi.fn(), onPushBranch = vi.fn();
    menu.show.mockResolvedValueOnce(menuAction);
    component = mount(GitGraph, { target: document.body, props: {
      snapshot, repositoryId: "repo", getRestoredScrollTop: () => 0, selectedCommit: null,
      changesSelected: false, scrollToCommit: null, onScrollTopChange: vi.fn(), onScrollCommandHandled: vi.fn(),
      onSelectChanges: vi.fn(), onSelectCommit: vi.fn(), onCompareCommitToWorkingTree: vi.fn(),
      canIntegrate: true, canRebase: true, canSwitchBranch: true, canPullOtherBranch: true, canPushOtherBranch: true,
      onIntegrateBranch, onSwitchBranch, onPullBranch, onPushBranch,
    } });
    flushSync();
    document.querySelector<HTMLButtonElement>(`[data-commit-hash="${hash}"]`)!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    if (operation === "merge" || operation === "rebase") await vi.waitFor(() => expect(onIntegrateBranch).toHaveBeenCalledWith(branch, operation));
    else if (operation === "checkout") await vi.waitFor(() => expect(onSwitchBranch).toHaveBeenCalledWith("topic"));
    else if (operation === "pull") await vi.waitFor(() => expect(onPullBranch).toHaveBeenCalledWith(branch));
    else await vi.waitFor(() => expect(onPushBranch).toHaveBeenCalledWith(branch));
  });

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

  it("hides integration actions on older commits shown on the current branch", () => {
    const head = "a".repeat(40), old = "b".repeat(40);
    const commits = [
      { hash: head, parents: [old], author: "Author", timestamp: 2, message: "Head" },
      { hash: old, parents: [], author: "Author", timestamp: 1, message: "Older commit" },
    ];
    const snapshot: RepositorySnapshot = {
      info: { path: "/repo", root: "/repo" },
      status: { currentBranch: "main", headOid: head, ahead: 0, behind: 0, changedFiles: [] },
      commits, refs: [{ name: "refs/heads/main", shortName: "main", refType: "localBranch", target: head }], stashes: [], worktrees: [],
      graph: { commits: [{ hash: head, row: 0, lane: 0 }, { hash: old, row: 1, lane: 0 }], edges: [], headLane: 0, width: 1 },
    };
    component = mount(GitGraph, { target: document.body, props: {
      snapshot, repositoryId: "repo", getRestoredScrollTop: () => 0, selectedCommit: null,
      changesSelected: false, scrollToCommit: null, onScrollTopChange: vi.fn(), onScrollCommandHandled: vi.fn(),
      onSelectChanges: vi.fn(), onSelectCommit: vi.fn(), onCompareCommitToWorkingTree: vi.fn(),
      canIntegrate: true, canRebase: true, onRebaseCommit: vi.fn(),
    } });
    flushSync();
    document.querySelector<HTMLButtonElement>(`[data-commit-hash="${old}"]`)!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const items = menu.show.mock.calls[0][0] as Array<{ id: string }>;
    expect(items.some((item) => ["merge-commit", "rebase-commit", "interactive-rebase", "squash"].includes(item.id))).toBe(false);
  });

  it("shows branch actions directly and disables integration when the branch is ambiguous", async () => {
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
    menu.show.mockResolvedValueOnce("dismissed");
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
    const items = menu.show.mock.calls[0][0] as Array<{ id: string; label: string; children?: Array<{ id: string; label: string; disabled?: boolean }> }>;
    expect(items.find((item) => item.id === "rebase-commit")).toMatchObject({ label: "Rebase main onto selected branch", disabled: true });
    expect(items.filter((item) => item.id.startsWith("rename:")).map((item) => item.label)).toEqual(["Rename main…", "Rename topic…"]);
    expect(items.find((item) => item.id === "delete:refs/heads/topic")).toBeDefined();
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
