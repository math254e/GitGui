// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import RepositoryLocations from "./RepositoryLocations.svelte";
import { dismissContextMenu } from "$lib/contextMenu";

const menu = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock("$lib/contextMenu", () => ({ showContextMenu: menu.show, dismissContextMenu: vi.fn() }));
vi.mock("@lucide/svelte", () => ({ Monitor: () => {}, Server: () => {}, Folder: () => {} }));

let component: ReturnType<typeof mount> | undefined;
afterEach(async () => { if (component) await unmount(component); component = undefined; dismissContextMenu(); document.body.replaceChildren(); });

describe("repository locations", () => {
  it("shows the host path for a local checkout and preserves the remote label and missing state", () => {
    const container = document.createElement("div"); document.body.append(container);
    const current = { environmentId: "local", repositoryId: "one" };
    component = mount(RepositoryLocations, { target: container, props: {
      current, sourceTabId: "tab", onSwitch: vi.fn(), onOpenInNewTab: vi.fn(),
      environments: [
        { environmentId: "local", label: "GitGui on DESKTOP", local: true, status: "connected", locations: [{ target: current, path: "D:/work/gitgui", missing: false, current: true }] },
        { environmentId: "remote", label: "Build host", status: "offline", locations: [{ target: { environmentId: "remote", repositoryId: "two" }, path: "/srv/gitgui", missing: true, current: false }] },
      ],
    } }); flushSync();
    expect(container.textContent).toContain("D:/work/gitgui");
    expect(container.textContent).not.toContain("GitGui on DESKTOP");
    expect(container.textContent).toContain("Build host");
    expect(container.textContent).toContain("/srv/gitgui");
    expect(container.textContent).toContain("Missing");
    expect(container.textContent).toContain("Offline");
    expect(container.querySelector('[aria-label="Local, D:/work/gitgui"]')).not.toBeNull();
  });

  it("shows a saved disconnected location as not connected and retains its scoped action", () => {
    const container = document.createElement("div"); document.body.append(container);
    const current = { environmentId: "local", repositoryId: "one" };
    const target = { environmentId: "remote", repositoryId: "two" };
    const onSwitch = vi.fn();
    component = mount(RepositoryLocations, { target: container, props: {
      current, sourceTabId: "tab", onSwitch, onOpenInNewTab: vi.fn(),
      environments: [{ environmentId: "remote", label: "Build host", status: "available", locations: [{ target, path: "/srv/gitgui", missing: false, current: false }] }],
    } }); flushSync();
    expect(container.textContent).toContain("Not connected");
    expect(container.textContent).not.toContain("Connecting");
    container.querySelector<HTMLButtonElement>('[aria-label="Build host, /srv/gitgui, available"]')!.click();
    expect(onSwitch).toHaveBeenCalledWith(target, { tabId: "tab", target: current });
  });
  it("opens the keyboard context menu with the originating tab and checkout", async () => {
    const container = document.createElement("div"); document.body.append(container);
    const current = { environmentId: "a", repositoryId: "one" };
    const target = { environmentId: "b", repositoryId: "one" };
    const open = vi.fn();
    menu.show.mockResolvedValueOnce("open");
    component = mount(RepositoryLocations, { target: container, props: {
      current, sourceTabId: "tab-a", onSwitch: vi.fn(), onOpenInNewTab: open,
      environments: [{ environmentId: "b", label: "Remote", status: "connected", locations: [{ target, path: "/repo", missing: false, current: false }] }],
    } });
    flushSync();
    container.querySelector<HTMLButtonElement>('button[aria-label="Remote, /repo"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true }));
    await Promise.resolve();
    expect(open).toHaveBeenCalledWith(target, { tabId: "tab-a", target: current });
  });
  it("shows single locations as rows and expands multiple locations with scoped targets", () => {
    const container = document.createElement("div"); document.body.append(container);
    const current = { environmentId: "a", repositoryId: "one" };
    const switchTarget = vi.fn();
    const remote = { environmentId: "b", repositoryId: "two" };
    component = mount(RepositoryLocations, { target: container, props: {
      current, sourceTabId: "tab-a", onSwitch: switchTarget, onOpenInNewTab: vi.fn(),
      environments: [
        { environmentId: "a", label: "Local", status: "connected", locations: [{ target: current, path: "/one", missing: false, current: true }] },
        { environmentId: "b", label: "Agentbox", status: "offline", locations: [
          { target: remote, path: "/two", missing: false, current: false },
          { target: { environmentId: "b", repositoryId: "three" }, path: "/three", missing: true, current: false },
        ] },
      ],
    } });
    flushSync();
    const local = container.querySelector<HTMLButtonElement>('button[aria-label="Local, /one"]')!;
    expect(local.getAttribute("aria-current")).toBe("true");
    const folder = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Agentbox"))!;
    expect(folder.getAttribute("aria-expanded")).toBe("false");
    folder.click(); flushSync();
    expect(folder.getAttribute("aria-expanded")).toBe("true");
    container.querySelector<HTMLButtonElement>('button[aria-label="Agentbox, /two"]')!.click();
    expect(switchTarget).toHaveBeenCalledWith(remote, { tabId: "tab-a", target: current });
    expect(container.textContent).toContain("Missing");
    expect(container.textContent).toContain("Offline");
  });
});
