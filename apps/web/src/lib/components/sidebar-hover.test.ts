// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import type { CommitInfo, CommitRef, StashInfo } from "$lib/types/repository";
import { dismissContextMenu } from "$lib/contextMenu";
import BranchTree from "./BranchTree.svelte";
import StashTree from "./StashTree.svelte";
import WorktreeTree from "./WorktreeTree.svelte";
import StashTreeLifecycle from "./__tests__/StashTreeLifecycle.svelte";

const commit: CommitInfo = { hash: "a".repeat(40), parents: [], author: "Branch author", timestamp: 1700000000, message: "Implement sidebar" };
const branch: CommitRef = { name: "refs/heads/feature/sidebar", shortName: "feature/sidebar", target: commit.hash, refType: "localBranch" };
const stash: StashInfo = { selector: "stash@{0}", hash: "b".repeat(40), baseHash: commit.hash, indexHash: null, branch: "feature/sidebar", message: "Saved / sidebar <work>", timestamp: 1700000001 };
let component: ReturnType<typeof mount> | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  dismissContextMenu(); document.body.replaceChildren();
  vi.unstubAllGlobals(); vi.useRealTimers();
});
function target() { const node = document.createElement("div"); document.body.append(node); return node; }
function rows(target: HTMLElement) {
  const host = target.querySelector<HTMLElement>('[role="group"]')!;
  return { host, row: host.shadowRoot!.querySelector<HTMLElement>('[data-type="item"][data-item-type="file"]')! };
}
function hover(row: HTMLElement) { row.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, composed: true })); }
async function openCard() { await tick(); await vi.advanceTimersByTimeAsync(300); await tick(); }
function card() { return document.querySelector<HTMLElement>('[role="tooltip"]'); }

describe("sidebar detail cards", () => {
  it("shows worktree snapshot details without switching repositories, preserving double-click navigation", async () => {
    const container = target(), onSwitchWorktree = vi.fn();
    const worktree = { path: "D:\\work\\sidebar", branch: branch.shortName, headOid: commit.hash, current: true, isMain: false };
    component = mount(WorktreeTree, { target: container, props: { worktrees: [worktree], treeId: "hover-worktree", contextKey: "env:repo", commitsByHash: new Map([[commit.hash, commit]]), onSwitchWorktree } });
    flushSync(); await tick(); const { row } = rows(container);
    hover(row); await openCard();
    for (const text of ["sidebar", "Linked worktree", "Current worktree", worktree.path, branch.shortName, commit.hash, commit.author, commit.message]) expect(card()?.textContent).toContain(text);
    expect(onSwitchWorktree).not.toHaveBeenCalled();
    row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, composed: true, cancelable: true }));
    expect(onSwitchWorktree).toHaveBeenCalledExactlyOnceWith(worktree.path);
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, composed: true, cancelable: true })); await tick();
    expect(card()).toBeNull();
  });

  it.each([null, "0".repeat(40), commit.hash])("handles detached or unborn worktrees without commit metadata (%s)", async (headOid) => {
    const container = target();
    component = mount(WorktreeTree, { target: container, props: { worktrees: [{ path: "/work/main", branch: null, headOid, current: false, isMain: true }], treeId: "hover-detached", contextKey: "env:repo" } });
    flushSync(); await tick(); const { row } = rows(container);
    row.focus(); await openCard();
    expect(card()?.textContent).toContain("Main worktree");
    expect(card()?.textContent).not.toContain("Current worktree");
    expect(card()?.textContent).toContain(headOid === commit.hash ? "Detached HEAD" : "No commit yet");
    if (headOid === commit.hash) expect(card()?.textContent).toContain(commit.hash);
    expect(card()?.textContent).not.toContain("Author");
  });

  it("shows current branch snapshot details after a delay without selecting or switching", async () => {
    const container = target(), onSelectRef = vi.fn(), onSwitchBranch = vi.fn();
    component = mount(BranchTree, { target: container, props: { refs: [branch], refType: "localBranch", treeId: "hover-local", contextKey: "env:repo", currentBranch: branch.shortName,
      commitsByHash: new Map([[commit.hash, commit]]), status: { currentBranch: branch.shortName, headOid: commit.hash, ahead: 2, behind: 1, changedFiles: [] },
      worktrees: [{ path: "D:/work/sidebar", branch: branch.shortName, headOid: commit.hash, current: true }], onSelectRef, onSwitchBranch } });
    flushSync(); await tick(); const { row } = rows(container);
    hover(row); await tick(); await vi.advanceTimersByTimeAsync(200);
    expect(card()).toBeNull();
    await vi.advanceTimersByTimeAsync(100); await tick();
    for (const text of [branch.shortName, "Local branch", "Current branch", commit.hash, commit.author, commit.message, "2 ahead", "1 behind", "D:/work/sidebar"]) expect(card()?.textContent).toContain(text);
    expect(onSelectRef).not.toHaveBeenCalled(); expect(onSwitchBranch).not.toHaveBeenCalled();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); await tick();
    expect(card()).toBeNull();
  });

  it("supports remote branches and dismisses cards when virtualized rows are recycled", async () => {
    const container = target();
    const remote = { ...branch, name: "refs/remotes/origin/feature/sidebar", shortName: "origin/feature/sidebar", refType: "remoteBranch" as const };
    component = mount(BranchTree, { target: container, props: { refs: [remote], refType: "remoteBranch", treeId: "hover-remote", contextKey: "env:repo", commitsByHash: new Map([[commit.hash, commit]]) } });
    flushSync(); await tick(); const { row } = rows(container);
    hover(row); await openCard();
    expect(card()?.textContent).toContain("Remote-tracking branch");
    expect(card()?.textContent).toContain(remote.shortName);
    expect(card()?.textContent).not.toContain("Current branch");
    row.dataset.itemPath = "origin/other";
    await new Promise<void>((resolve) => queueMicrotask(resolve)); await tick();
    expect(card()).toBeNull();
  });

  it("ignores branch folders and visibility controls", async () => {
    const container = target();
    component = mount(BranchTree, { target: container, props: { refs: [branch], refType: "localBranch", treeId: "hover-folders" } });
    flushSync(); await tick(); const { host, row } = rows(container);
    const folder = host.shadowRoot!.querySelector<HTMLElement>('[data-item-type="folder"]')!;
    hover(folder); await openCard(); expect(card()).toBeNull();
    hover(row.querySelector<HTMLElement>('[data-item-section="decoration"]')!);
    await openCard(); expect(card()).toBeNull();
  });

  it("shows stash details on keyboard focus with safe labels and no selection", async () => {
    const container = target(), onSelect = vi.fn(), onAction = vi.fn();
    component = mount(StashTree, { target: container, props: { stashes: [{ ...stash, branch: null }], contextKey: "env:repo", commitsByHash: new Map([[commit.hash, commit]]),
      capabilities: { apply: false, pop: false, drop: false, branch: false }, onSelect, onAction } });
    flushSync(); await tick(); const { row } = rows(container);
    row.focus(); await openCard();
    for (const text of [stash.selector, stash.message, "Unknown", stash.hash, stash.baseHash, commit.message]) expect(card()?.textContent).toContain(text);
    expect(card()?.querySelector("work")).toBeNull();
    expect(onSelect).not.toHaveBeenCalled(); expect(onAction).not.toHaveBeenCalled();
    row.dispatchEvent(new Event("scroll")); await tick();
    expect(card()).toBeNull();
  });

  it("keeps the card open while the pointer enters it, then closes after leaving", async () => {
    const container = target();
    component = mount(StashTree, { target: container, props: { stashes: [stash], contextKey: "env:repo", capabilities: { apply: false, pop: false, drop: false, branch: false }, onSelect: vi.fn(), onAction: vi.fn() } });
    flushSync(); await tick(); const { row } = rows(container);
    hover(row); await openCard(); const surface = card()!;
    row.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, composed: true, relatedTarget: surface }));
    surface.dispatchEvent(new Event("pointerenter")); await tick();
    await vi.advanceTimersByTimeAsync(150); expect(card()).toBe(surface);
    surface.dispatchEvent(new Event("pointerleave")); await tick();
    await vi.advanceTimersByTimeAsync(120); await tick(); expect(card()).toBeNull();
  });

  it("dismisses on menus, context replacement, and unmount without leaving a card behind", async () => {
    const container = target();
    component = mount(StashTreeLifecycle, { target: container, props: { stash, onSelect: vi.fn(), onAction: vi.fn() } });
    flushSync(); await tick(); let { row } = rows(container);
    hover(row); await openCard(); expect(card()).not.toBeNull();
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, composed: true, cancelable: true })); await tick();
    expect(card()).toBeNull(); dismissContextMenu(); await tick();
    hover(row); await openCard(); expect(card()).not.toBeNull();
    container.querySelector<HTMLButtonElement>("[data-switch-context]")!.click(); await tick();
    expect(card()).toBeNull();
    row = rows(container).row; hover(row); await openCard(); expect(card()).not.toBeNull();
    await unmount(component); component = undefined;
    expect(card()).toBeNull();
  });
});
