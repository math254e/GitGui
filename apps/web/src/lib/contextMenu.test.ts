// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dismissContextMenu, isContextMenuOpen, showContextMenu } from "./contextMenu";

let frames: FrameRequestCallback[];
beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
});
afterEach(() => { dismissContextMenu(); document.body.replaceChildren(); vi.unstubAllGlobals(); });
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
