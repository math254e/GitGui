// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import Harness from "./Component.test-harness.svelte";
import HistoryToolbar from "./HistoryToolbar.svelte";
import { dismissContextMenu } from "$lib/contextMenu";

vi.mock("@lucide/svelte", () => ({ Archive: () => {}, ArchiveRestore: () => {}, ArrowDownToLine: () => {}, Download: () => {}, LoaderCircle: () => {}, Upload: () => {}, FolderOpen: () => {}, ChevronDown: () => {} }));

let component: { update(value: Record<string, unknown>): void } | undefined;
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  dismissContextMenu();
  localStorage.clear();
  document.body.replaceChildren();
});

describe("repository open action", () => {
  it("opens the chosen app and remembers it separately for each repository", async () => {
    const vscode = vi.fn().mockResolvedValue(undefined);
    const explorer = vi.fn().mockResolvedValue(undefined);
    const noop = () => {};
    component = mount(Harness, { target: document.body, props: { component: HistoryToolbar, initialProps: {
      onFetch: noop, onPull: noop, onPush: noop, onBranch: noop, onStash: noop, onPop: noop,
      onOpenInVSCode: vscode, onOpenInExplorer: explorer, canOpenRepositoryLocally: true, repositoryKey: "repo-a",
    } } });
    flushSync();
    document.querySelector<HTMLButtonElement>('[aria-label="Choose where to open repository"]')!.click();
    flushSync();
    const explorerItem = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === "Explorer")!;
    explorerItem.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    await tick(); await tick();
    expect(explorer).toHaveBeenCalledOnce();
    expect(document.querySelector('[aria-label="Open in Explorer"]')).not.toBeNull();
    component.update({ repositoryKey: "repo-b" }); flushSync();
    expect(document.querySelector('[aria-label="Open in Visual Studio Code"]')).not.toBeNull();
    component.update({ repositoryKey: "repo-a" }); flushSync();
    document.querySelector<HTMLButtonElement>('[aria-label="Open in Explorer"]')!.click();
    await tick();
    expect(explorer).toHaveBeenCalledTimes(2);
    expect(vscode).not.toHaveBeenCalled();
  });
});
