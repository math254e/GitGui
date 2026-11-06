// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import ConnectionsSettingsPanel from "./ConnectionsSettingsPanel.svelte";
import type { WebApplicationRuntimeState } from "$lib/connection/runtime";

const fixture = vi.hoisted(() => ({ runtime: undefined as unknown }));
vi.mock("$lib/connection/runtime", () => ({ useWebApplicationRuntime: () => fixture.runtime }));
vi.mock("@lucide/svelte", () => ({ GitBranch: () => {}, Info: () => {} }));

let component: ReturnType<typeof mount> | undefined;
afterEach(async () => { if (component) await unmount(component); component = undefined; document.body.replaceChildren(); });

function setup() {
  const connection: NonNullable<WebApplicationRuntimeState["connection"]> = {
    desired: true, network: "online", phase: "connected", stage: null, attempt: 0, generation: 1, lastFailure: null, retryAt: null,
  };
  const state: WebApplicationRuntimeState = { registry: { entries: [
    { registration: { environmentId: "primary", displayName: "Workstation", target: { kind: "primary" } }, connection },
    { registration: { environmentId: "remote", displayName: "Build host", target: { kind: "ssh" } }, connection: { ...connection, phase: "offline" } },
  ] }, catalogs: {}, repositoryGroups: [], connection: null, client: null, workspace: null, workspaceState: null, loading: false, error: "" };
  const runtime = { state, isDesktop: true, tabOwnership: "external",
    subscribe: (listener: (value: WebApplicationRuntimeState) => void) => { listener(state); return () => {}; },
    addDirect: vi.fn().mockResolvedValue("direct"), addSsh: vi.fn().mockResolvedValue("ssh"),
    renameEnvironment: vi.fn().mockResolvedValue(undefined), discoverSshHosts: vi.fn().mockResolvedValue([]),
  };
  fixture.runtime = runtime;
  const target = document.createElement("div"); document.body.append(target);
  component = mount(ConnectionsSettingsPanel, { target }); flushSync();
  const button = (text: string) => [...target.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.trim() === text)!;
  const input = (section: string, label: string) => [...target.querySelectorAll<HTMLLabelElement>(`section[aria-labelledby="${section}"] label`)]
    .find((entry) => entry.querySelector("span")?.textContent === label)!.querySelector<HTMLInputElement>("input")!;
  const fill = async (element: HTMLInputElement, value: string) => { element.value = value; element.dispatchEvent(new Event("input", { bubbles: true })); await tick(); };
  return { runtime, target, button, input, fill };
}

describe("connection names in settings", () => {
  it("uses readable connection summaries while retaining environment IDs in details", () => {
    const f = setup();
    expect(f.target.textContent).toContain("This computer");
    expect(f.target.textContent).toContain("SSH connection");
    expect(f.target.textContent).toContain("Offline");
    const details = [...f.target.querySelectorAll("details")].find((entry) => entry.textContent?.includes("Environment ID") && entry.textContent?.includes("primary"))!;
    expect(details.open).toBe(false);
    expect(details.querySelector("dd")?.textContent).toBe("primary");
    details.querySelector("summary")!.click();
    expect(details.open).toBe(true);
    expect(f.target.querySelector('[aria-label="Rename Workstation"]')).not.toBeNull();
    expect(f.target.querySelector('[aria-label="Rename Build host"]')).not.toBeNull();
  });
  it("passes the configured direct and SSH names without changing credentials or host fields", async () => {
    const f = setup();
    await f.fill(f.input("connections-direct", "Environment name"), "Office");
    await f.fill(f.input("connections-direct", "Server address"), "https://office.example.com");
    f.button("Connect server").click();
    await vi.waitFor(() => expect(f.runtime.addDirect).toHaveBeenCalledWith("https://office.example.com", undefined, "Office"));
    await tick();
    await f.fill(f.input("connections-ssh", "Environment name"), "Build server");
    await f.fill(f.input("connections-ssh", "Host"), "build-alias");
    f.button("Connect over SSH").click();
    await vi.waitFor(() => expect(f.runtime.addSsh).toHaveBeenCalledWith({ kind: "ssh", host: "build-alias" }, undefined, expect.any(AbortSignal), "Build server"));
  });

  it("offers rename for the primary and offline SSH environment and keeps failed edits open", async () => {
    const f = setup();
    f.target.querySelector<HTMLButtonElement>('[aria-label="Rename Workstation"]')!.click(); await tick();
    await f.fill(f.target.querySelector<HTMLInputElement>("form input")!, "My desktop");
    f.target.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(f.runtime.renameEnvironment).toHaveBeenCalledWith("primary", "My desktop")); await tick();
    expect(f.target.querySelector("form")).toBeNull();
    f.target.querySelector<HTMLButtonElement>('[aria-label="Rename Build host"]')!.click(); await tick();
    await f.fill(f.target.querySelector<HTMLInputElement>("form input")!, "Remote build");
    f.runtime.renameEnvironment.mockRejectedValueOnce(new Error("Name could not be saved"));
    f.target.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(f.target.textContent).toContain("Name could not be saved"));
    expect(f.target.querySelector<HTMLInputElement>("form input")!.value).toBe("Remote build");
    f.button("Cancel").click(); await tick();
    expect(f.target.querySelector("form")).toBeNull();
  });
});
