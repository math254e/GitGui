// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dismissContextMenu, isContextMenuOpen, showContextMenu } from "./contextMenu";

let frames: FrameRequestCallback[];
beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
});
afterEach(() => { dismissContextMenu(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function key(key: string) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  document.activeElement!.dispatchEvent(event);
  return event;
}
function invoker() {
  const button = document.createElement("button");
  document.body.append(button); button.focus();
  return button;
}
const activeLabel = () => document.activeElement?.textContent;

describe("context menu keyboard ownership", () => {
  it("lays out a tall menu in columns without scrolling and keeps every item keyboard accessible", async () => {
    vi.stubGlobal("innerHeight", 400);
    vi.stubGlobal("innerWidth", 800);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return { x: 0, y: 0, left: 0, top: 0, right: 240, bottom: 800, width: 240, height: 800, toJSON: () => ({}) };
    });
    const result = showContextMenu(Array.from({ length: 20 }, (_, index) => ({ id: `item-${index}`, label: `Item ${index}` })));
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    const inner = menu.firstElementChild as HTMLElement;
    expect(inner.style.overflowY).not.toBe("auto");
    expect(inner.style.display).toBe("grid");
    expect(inner.style.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");
    expect(menu.querySelectorAll("button")).toHaveLength(20);
    key("End"); expect(activeLabel()).toBe("Item 19");
    key("Enter"); await expect(result).resolves.toBe("item-19");
  });

  it("dismisses the menu when the viewport changes", async () => {
    const result = showContextMenu([{ id: "item", label: "Item" }]);
    window.dispatchEvent(new Event("resize"));
    await expect(result).resolves.toBeNull();
  });
  it("focuses the first enabled item and navigates/wraps over headers, separators, and disabled items without moving the graph", async () => {
    const graphRow = invoker();
    const navigateGraph = vi.fn(); graphRow.addEventListener("keydown", navigateGraph);
    const result = showContextMenu([
      { id: "heading", label: "Saved work", header: true },
      { id: "disabled", label: "Unavailable", disabled: true },
      { id: "apply", label: "Apply", separatorBefore: true },
      { id: "pop", label: "Pop" }, { id: "drop", label: "Delete", separatorBefore: true },
    ]);
    expect(activeLabel()).toBe("Apply");
    expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
    expect(key("ArrowUp").defaultPrevented).toBe(true); expect(activeLabel()).toBe("Delete");
    key("ArrowDown"); expect(activeLabel()).toBe("Apply");
    key("End"); expect(activeLabel()).toBe("Delete");
    key("Home"); key("ArrowDown"); expect(activeLabel()).toBe("Pop");
    // Even if another component steals focus, capture prevents background keys.
    graphRow.focus(); key("ArrowDown"); expect(activeLabel()).toBe("Apply");
    key("ArrowDown");
    // Keyboard activation works immediately, without waiting for the pointer guard's RAF.
    key("Enter");
    await expect(result).resolves.toBe("pop");
    expect(navigateGraph).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(graphRow);
    expect(isContextMenuOpen()).toBe(false);
  });

  it("opens submenus by Right/Enter, navigates their enabled children, and returns to the parent by Left", async () => {
    const trigger = invoker();
    const result = showContextMenu([{ id: "parent", label: "Branches", children: [
      { id: "disabled", label: "Unavailable", disabled: true },
      { id: "rename", label: "Rename" }, { id: "remove", label: "Remove" },
    ] }, { id: "other", label: "Other" }]);
    const parent = document.activeElement!;
    key("ArrowRight"); expect(activeLabel()).toBe("Rename");
    expect(parent.getAttribute("aria-expanded")).toBe("true");
    key("ArrowDown"); expect(activeLabel()).toBe("Remove");
    key("ArrowLeft"); expect(document.activeElement).toBe(parent);
    expect(parent.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
    key("Enter"); expect(activeLabel()).toBe("Rename");
    key("End"); key(" ");
    await expect(result).resolves.toBe("remove");
    expect(document.activeElement).toBe(trigger);
  });

  it("cancels with Escape and restores focus only while the invoking target still exists", async () => {
    const trigger = invoker();
    const result = showContextMenu([{ id: "apply", label: "Apply" }]);
    key("Escape"); await expect(result).resolves.toBeNull();
    expect(document.activeElement).toBe(trigger);
    const removed = showContextMenu([{ id: "apply", label: "Apply" }]);
    trigger.remove(); const focus = vi.spyOn(trigger, "focus");
    key("Escape"); await expect(removed).resolves.toBeNull();
    expect(focus).not.toHaveBeenCalled();
  });

  it("keeps all-disabled menus keyboard-owned and preserves owner-scoped dismissal", async () => {
    const trigger = invoker(); const owner = {};
    const result = showContextMenu([{ id: "apply", label: "Apply", disabled: true }], undefined, owner);
    expect(document.activeElement?.getAttribute("role")).toBe("menu");
    key("ArrowDown"); key("Enter"); expect(isContextMenuOpen()).toBe(true);
    dismissContextMenu({}); expect(isContextMenuOpen()).toBe(true);
    dismissContextMenu(owner); await expect(result).resolves.toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("shows a hover reason and neutral icon for disabled destructive actions", async () => {
    const result = showContextMenu([{ id: "delete", label: "Delete branch…", icon: "trash", destructive: true, disabled: true, disabledReason: "Branch is checked out." }]);
    const button = document.querySelector<HTMLButtonElement>('button[role="menuitem"]')!;
    expect(button.disabled).toBe(true);
    expect(button.parentElement?.title).toBe("Branch is checked out.");
    expect(button.style.pointerEvents).toBe("none");
    expect(button.querySelector("svg")?.getAttribute("style")).toContain("var(--app-theme-muted-foreground)");
    dismissContextMenu(); await expect(result).resolves.toBeNull();
  });

  it("preserves mouse hover submenus and pointer selection/outside dismissal", async () => {
    invoker();
    const result = showContextMenu([{ id: "parent", label: "Branches", children: [{ id: "rename", label: "Rename" }] }]);
    document.querySelector("button[aria-haspopup]")!.dispatchEvent(new MouseEvent("mouseenter"));
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(2);
    frames.splice(0).forEach((callback) => callback(0));
    const child = document.querySelector<HTMLButtonElement>('[data-level="1"] button')!;
    child.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
    await expect(result).resolves.toBe("rename");
    const outside = showContextMenu([{ id: "apply", label: "Apply" }]);
    frames.splice(0).forEach((callback) => callback(0));
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    await expect(outside).resolves.toBeNull();
  });
});
