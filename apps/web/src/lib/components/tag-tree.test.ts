// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import type { CommitRef, RepositorySnapshot } from "$lib/types/repository";
import { graphRefKey } from "$lib/types/branch-visibility";
import TagTree from "./TagTree.svelte";
import Sidebar from "./Sidebar.svelte";
import { dismissContextMenu, isContextMenuOpen } from "$lib/contextMenu";

// Icons have no behavior under test; the app's test compiler excludes dependency Svelte files.
vi.mock("@lucide/svelte", () => ({ Eye: () => {}, EyeOff: () => {}, Tag: () => {} }));

let component: ReturnType<typeof mount> | undefined;
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(260);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  localStorage.clear();
});
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  dismissContextMenu();
  document.body.replaceChildren();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  vi.useRealTimers();
});
function tag(index: number): CommitRef {
  return { name: `refs/tags/releases/v${index}`, shortName: `releases/v${index}`, target: "a".repeat(40), objectId: "b".repeat(40), refType: "tag" };
}

describe("tag navigation", () => {
  it("offers checkout and push without changing graph selection", async () => {
    const target = document.createElement("div"); document.body.append(target);
    const entry = tag(1), onCheckoutTag = vi.fn(), onPushTag = vi.fn(), onSelectRef = vi.fn();
    component = mount(TagTree, { target, props: { tags: [entry], commitHashes: new Set([entry.target]), visibleRefKeys: new Set<string>(), contextKey: "env:repo", canCheckoutTag: true, canPushTag: true, onCheckoutTag, onPushTag, onSelectRef } });
    flushSync(); await tick();
    const row = target.querySelector<HTMLButtonElement>("[data-tag-index]")!;
    for (const text of ["Checkout releases/v1", "Push tag"]) {
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      const action = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === text)!;
      expect(action.getAttribute("aria-disabled")).not.toBe("true"); action.click(); await tick();
    }
    expect(onCheckoutTag).toHaveBeenCalledExactlyOnceWith(entry);
    expect(onPushTag).toHaveBeenCalledExactlyOnceWith(entry);
    expect(onSelectRef).not.toHaveBeenCalled();
  });

  it("loads hover details only after the delay and closes the shared card on Escape", async () => {
    vi.useFakeTimers();
    const target = document.createElement("div"); document.body.append(target);
    const entry = tag(1);
    const loadTagDetails = vi.fn(async () => ({ annotated: true, message: "Release notes", tagger: "Tagger", timestamp: 1700000000, hasSignature: false }));
    component = mount(TagTree, { target, props: { tags: [entry], commitHashes: new Set([entry.target]), visibleRefKeys: new Set<string>(), contextKey: "env:repo", loadTagDetails } });
    flushSync(); await tick();
    const row = target.querySelector<HTMLButtonElement>("[data-tag-index]")!;
    row.dispatchEvent(new Event("pointerenter")); await tick();
    await vi.advanceTimersByTimeAsync(200);
    expect(loadTagDetails).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100); await tick(); await tick();
    expect(loadTagDetails).toHaveBeenCalledExactlyOnceWith(entry);
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("Release notes");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); await tick();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it("opens sidebar deletion without selecting a commit, including non-commit tags", async () => {
    const target = document.createElement("div"); document.body.append(target);
    const entry = tag(1);
    const snapshot = { refs: [entry], commits: [], worktrees: [], stashes: [] } as unknown as RepositorySnapshot;
    const onDeleteTag = vi.fn(), onSelectRef = vi.fn();
    component = mount(Sidebar, { target, props: { snapshot, selectedCommit: null, stateKey: "env:repo", canDeleteTag: true, onDeleteTag, onSelectRef } });
    flushSync(); await tick();
    const row = target.querySelector<HTMLButtonElement>("[data-tag-index]")!;
    row.focus();
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }));
    await tick();
    expect(isContextMenuOpen()).toBe(true);
    const action = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.includes("Delete tag"))!;
    expect(action.textContent).toContain("Delete tag");
    action.click(); await tick();
    expect(onDeleteTag).toHaveBeenCalledExactlyOnceWith(entry);
    expect(onSelectRef).not.toHaveBeenCalled();
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true }));
    expect(isContextMenuOpen()).toBe(true);
    await unmount(component); component = undefined;
    expect(isContextMenuOpen()).toBe(false);
    expect(onDeleteTag).toHaveBeenCalledTimes(1);
  });

  it("keeps deletion disabled without the reviewed object ID", async () => {
    const target = document.createElement("div"); document.body.append(target);
    const entry = { ...tag(1), objectId: undefined };
    const onDeleteTag = vi.fn();
    component = mount(TagTree, { target, props: { tags: [entry], commitHashes: new Set<string>(), visibleRefKeys: new Set<string>(), contextKey: "env:repo", canDeleteTag: true, onDeleteTag } });
    flushSync(); await tick();
    target.querySelector("[data-tag-index]")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const action = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.includes("Delete tag"))!;
    expect(action.getAttribute("aria-disabled")).toBe("true");
    action.click(); await tick();
    expect(onDeleteTag).not.toHaveBeenCalled();
  });

  it("mounts a bounded window of 10,000 tags and navigates to the last tag with the keyboard", async () => {
    const tags = Array.from({ length: 10_000 }, (_, i) => tag(i));
    const onSelectRef = vi.fn(), onToggleRefs = vi.fn();
    const target = document.createElement("div"); document.body.append(target);
    component = mount(TagTree, { target, props: { tags, commitHashes: new Set([tags[0].target]), visibleRefKeys: new Set(tags.map(graphRefKey)), contextKey: "env:repo", onSelectRef, onToggleRefs } });
    flushSync(); await tick();
    expect(target.querySelectorAll('[role="listitem"]').length).toBeLessThan(25);
    target.querySelector('[data-tag-index="0"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    await tick(); await tick();
    const last = target.querySelector<HTMLButtonElement>('[data-tag-index="9999"]')!;
    expect(last).not.toBeNull();
    expect(document.activeElement).toBe(last);
    last.click();
    expect(onSelectRef).toHaveBeenCalledExactlyOnceWith(tags[9999]);
    target.querySelector<HTMLButtonElement>('[aria-label="Hide tag releases/v9999 from graph"]')!.click();
    expect(onToggleRefs).toHaveBeenCalledExactlyOnceWith([tags[9999]], false);
    expect(onSelectRef).toHaveBeenCalledTimes(1);
    expect(target.querySelectorAll('[role="listitem"]').length).toBeLessThan(25);
  });

  it("places tags between remote branches and worktrees, sorts versions, and persists collapse state", async () => {
    const target = document.createElement("div"); document.body.append(target);
    const snapshot = { refs: [tag(10), tag(2)], commits: [], worktrees: [], stashes: [] } as unknown as RepositorySnapshot;
    const onSelectRef = vi.fn();
    const props = { snapshot, selectedCommit: null, stateKey: "env:repo", onSelectRef };
    component = mount(Sidebar, { target, props }); flushSync(); await tick();
    const headings = [...target.querySelectorAll("section > button")];
    expect(headings.map((el) => el.textContent?.trim())).toEqual(["Local branches (0)", "Remote branches (0)", "Tags (2)", "Worktrees (0)", "Stashes (0)"]);
    const rows = [...target.querySelectorAll<HTMLButtonElement>("[data-tag-index]")];
    expect(rows.map((el) => el.getAttribute("aria-label"))).toEqual(["releases/v2", "releases/v10"]);
    expect(rows[0].getAttribute("aria-disabled")).toBe("true");
    rows[0].click(); expect(onSelectRef).not.toHaveBeenCalled();
    (headings[2] as HTMLButtonElement).click(); await tick();
    expect(target.querySelector('[aria-label="Tags"]')).toBeNull();
    await unmount(component); component = undefined;
    component = mount(Sidebar, { target, props }); flushSync(); await tick();
    expect(target.querySelector('[aria-label="Tags"]')).toBeNull();
    expect(target.querySelector('[aria-controls="gitgui-tags"]')?.getAttribute("aria-expanded")).toBe("false");
  });
});
