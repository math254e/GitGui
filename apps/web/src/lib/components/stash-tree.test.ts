// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import type { StashInfo } from "@gitgui/contracts";
import { dismissContextMenu, isContextMenuOpen } from "$lib/contextMenu";
import StashTreeLifecycle from "./__tests__/StashTreeLifecycle.svelte";
import StashTree from "./StashTree.svelte";

const stash: StashInfo = { selector: "stash@{1}", hash: "a".repeat(40), message: "Older", baseHash: "b".repeat(40), indexHash: null, branch: "main", timestamp: 1 };
let component: ReturnType<typeof mount> | undefined;
afterEach(async () => { if (component) await unmount(component); component = undefined; dismissContextMenu(); document.body.replaceChildren(); });
function setup(initiallySelected = false) {
  const target = document.createElement("div"); document.body.append(target);
  const onSelect = vi.fn(), onAction = vi.fn();
  component = mount(StashTreeLifecycle, { target, props: { stash, onSelect, onAction, initiallySelected } });
  flushSync();
  const host = target.querySelector<HTMLElement>('section [aria-label="Stashes"]')!;
  const row = host.shadowRoot!.querySelector<HTMLElement>('[data-type="item"]')!;
  row.focus();
  return { target, host, row, onSelect, onAction };
}

describe("stash tree", () => {
  it("keeps selection and labels through metadata refresh and reopens selected details with Enter", async () => {
    const { target, host, onSelect } = setup(true);
    target.querySelector<HTMLButtonElement>("[data-refresh]")!.click();
    await tick();
    const row = host.shadowRoot!.querySelector<HTMLElement>('[data-type="item"]')!;
    expect(row.dataset.itemSelected).toBe("true");
    expect(row.getAttribute("aria-label")).toBe(`${stash.selector}: Updated stash message`);
    expect(onSelect).not.toHaveBeenCalled();
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true, cancelable: true }));
    await tick();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({ ...stash, message: "Updated stash message" });
    expect(target.querySelector('[data-open-diff="false"]')).not.toBeNull();
  });

  it("keeps stash order and duplicate messages as separate flat rows, including slash-containing labels", async () => {
    const target = document.createElement("div"); document.body.append(target);
    const stashes = [0, 1, 10].map((index) => ({ ...stash, selector: `stash@{${index}}`, message: "feature/sidebar: saved work" }));
    const onSelect = vi.fn();
    component = mount(StashTree, { target, props: { stashes, selectedStash: stashes[2], contextKey: "env:repo", capabilities: { apply: true, pop: true, drop: true, branch: true }, onSelect, onAction: vi.fn() } });
    flushSync(); await tick();
    const host = target.querySelector<HTMLElement>('[aria-label="Stashes"]')!;
    const rows = [...host.shadowRoot!.querySelectorAll<HTMLElement>('[data-type="item"]')];
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.dataset.itemPath)).toEqual(stashes.map((entry) => `${entry.selector}-${entry.hash}`));
    expect(rows.every((row) => row.dataset.itemType === "file")).toBe(true);
    expect(rows.map((row) => row.querySelector('[data-item-section="decoration"]')?.textContent)).toEqual(stashes.map((entry) => entry.message));
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual(stashes.map((entry) => `${entry.selector}: ${entry.message}`));
    expect(onSelect).not.toHaveBeenCalled();
    rows[2].click(); await tick();
    expect(onSelect).toHaveBeenCalledWith(stashes[2]);
  });

  it("keeps an open file diff and sidebar owner intact through right-click and keyboard menu actions", async () => {
    const { target, host, row, onSelect, onAction } = setup();
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, composed: true, cancelable: true, clientX: 20, clientY: 30 }));
    await tick();
    expect(onSelect).not.toHaveBeenCalled();
    expect(target.querySelector('[data-open-diff="true"]')).not.toBeNull();
    expect(isContextMenuOpen()).toBe(true);
    expect(host.shadowRoot!.querySelector('[data-stash-menu-highlight]')?.textContent).toContain(CSS.escape(row.dataset.itemPath!));
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    expect(document.activeElement?.textContent).toBe("Pop…");
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await tick();
    expect(onAction).toHaveBeenCalledWith("pop", stash);
    expect(onSelect).not.toHaveBeenCalled();
    expect(host.shadowRoot!.activeElement).toBe(row);
    // Shift+F10 uses the same owner; Escape restores the row, then click selects.
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, composed: true, cancelable: true }));
    expect(isContextMenuOpen()).toBe(true);
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await tick(); row.click(); await tick();
    expect(onSelect).toHaveBeenCalledWith(stash);
    expect(target.querySelector('[data-open-diff="false"]')).not.toBeNull();
  });

  it("dismisses on environment/repository context replacement and row destruction without a late action", async () => {
    const { target, row, onAction } = setup();
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, composed: true, cancelable: true }));
    target.querySelector<HTMLButtonElement>("[data-switch-context]")!.click();
    await tick(); expect(isContextMenuOpen()).toBe(false);
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, composed: true, cancelable: true }));
    expect(isContextMenuOpen()).toBe(true);
    await unmount(component!); component = undefined;
    expect(isContextMenuOpen()).toBe(false);
    expect(onAction).not.toHaveBeenCalled();
  });
});
