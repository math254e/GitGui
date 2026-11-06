// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import TopMenu from "./TopMenu.svelte";

vi.mock("@lucide/svelte", () => ({ Home: () => {}, Settings: () => {}, TreeDeciduous: () => {}, X: () => {}, Check: () => {}, Download: () => {}, LoaderCircle: () => {}, RefreshCw: () => {} }));

let component: ReturnType<typeof mount> | undefined;
afterEach(async () => { if (component) await unmount(component); document.body.replaceChildren(); });

function render(activeRepoId: string | null = "one") {
  const onSelectRepo = vi.fn(), onCloseRepo = vi.fn();
  component = mount(TopMenu, { target: document.body, props: {
    activeView: "repo", activeRepoId,
    tabs: [
      { id: "one", title: "GitGui", root: "/work/gitgui", branch: "main", isWorktree: false, error: "" },
      { id: "two", title: "GitGui · agentbox", root: "/srv/gitgui", branch: "agentbox · feature", isWorktree: true, error: "" },
    ], onShowStart: vi.fn(), onShowSettings: vi.fn(), onSelectRepo, onCloseRepo,
  } });
  flushSync();
  return { tabs: [...document.querySelectorAll<HTMLElement>('[role="tab"]')], onSelectRepo, onCloseRepo };
}

describe("repository tab keyboard navigation", () => {
  it("moves focus and selection with arrows, Home and End, wrapping at the edges", () => {
    const { tabs, onSelectRepo } = render();
    tabs[0].focus();
    tabs[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(tabs[1]);
    expect(onSelectRepo).toHaveBeenLastCalledWith("two");
    tabs[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(tabs[0]);
    tabs[0].dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(tabs[1]);
    tabs[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(tabs[0]);
  });

  it("keeps tabs reachable with no active selection and does not select when closing", () => {
    const { tabs, onSelectRepo, onCloseRepo } = render(null);
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1]);
    const close = tabs[1].querySelector("button")!;
    close.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    close.click();
    expect(onCloseRepo).toHaveBeenCalledExactlyOnceWith("two");
    expect(onSelectRepo).not.toHaveBeenCalled();
  });
});
