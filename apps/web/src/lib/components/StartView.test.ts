// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import StartView from "./StartView.svelte";

vi.mock("@lucide/svelte", () => ({ CloudDownload: () => {}, FolderOpen: () => {}, PlusSquare: () => {}, Search: () => {}, X: () => {} }));

let component: ReturnType<typeof mount> | undefined;
afterEach(async () => { if (component) await unmount(component); component = undefined; document.body.replaceChildren(); });

describe("repository home environment selection", () => {
  it("disables Open/Create/Remove for a limited session while retaining registered selection and a full host", async () => {
    const target = document.createElement("div"); document.body.append(target);
    const open = vi.fn(), remove = vi.fn();
    component = mount(StartView, { target, props: {
      repositories: [], loading: false, error: "", onChooseRepository: vi.fn(), onCreateRepository: vi.fn(), onRemoveRepository: vi.fn(), onOpenRepository: vi.fn(),
      groupedRepositories: [{ groupId: "repo", title: "Repo", locations: [{ target: { environmentId: "b", repositoryId: "same" }, environmentLabel: "Remote", path: "/repo", removeAvailability: { allowed: false, reason: "This session does not grant repository:manage permission." } }] }],
      onOpenScopedRepository: open, onRemoveScopedRepository: remove,
      environments: [{ id: "b", label: "Remote", primary: true, canOpen: false, canCreate: false, openReason: "This session does not grant repository:manage permission.", createReason: "This session does not grant repository:manage permission." },
        { id: "a", label: "Full", primary: false, canOpen: true, canCreate: true }],
    } }); flushSync();
    const button = (label: string) => [...target.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === label)!;
    expect(button("Open").disabled).toBe(true); expect(button("Create").disabled).toBe(true);
    expect(target.textContent).toContain("repository:manage");
    target.querySelector<HTMLButtonElement>('[aria-label^="Remove Repo at /repo from GitGui"]')!.click(); expect(remove).not.toHaveBeenCalled();
    target.querySelector<HTMLButtonElement>('[aria-label="Repo, Remote, /repo"]')!.click(); expect(open).toHaveBeenCalledWith({ environmentId: "b", repositoryId: "same" });
    const select = target.querySelector<HTMLSelectElement>("select")!;
    select.value = "a"; select.dispatchEvent(new Event("change", { bubbles: true })); await tick(); flushSync();
    expect(button("Open").disabled).toBe(false); expect(button("Create").disabled).toBe(false);
  });

  it("treats absent authorization as unavailable", () => {
    const target = document.createElement("div"); document.body.append(target);
    component = mount(StartView, { target, props: { repositories: [], loading: false, error: "", onChooseRepository: vi.fn(), onCreateRepository: vi.fn(), onRemoveRepository: vi.fn(), onOpenRepository: vi.fn() } }); flushSync();
    expect(target.textContent).toContain("Session authorization is unavailable");
    expect([...target.querySelectorAll("button")].filter((button) => ["Open", "Create"].includes(button.textContent?.trim() ?? "")).every((button) => button.disabled)).toBe(true);
  });

  it("shows independent initial catalog failures and loading with scoped retry while healthy repositories remain usable", () => {
    const target = document.createElement("div"); document.body.append(target);
    const retry = vi.fn(), open = vi.fn();
    component = mount(StartView, { target, props: {
      repositories: [], loading: false, error: "", onChooseRepository: vi.fn(), onCreateRepository: vi.fn(), onRemoveRepository: vi.fn(), onOpenRepository: vi.fn(),
      groupedRepositories: [{ groupId: "healthy", title: "Healthy repo", locations: [{ target: { environmentId: "healthy", repositoryId: "repo" }, environmentLabel: "Healthy host", path: "/repo" }] }],
      onOpenScopedRepository: open, onRetryEnvironmentCatalog: retry,
      environmentCatalogs: [
        { id: "a", label: "First host", loading: false, error: "Permission denied", connectionStatus: "connected" },
        { id: "b", label: "Second host", loading: false, error: "Catalog unavailable", connectionStatus: "connected" },
        { id: "c", label: "Loading host", loading: true, error: "", connectionStatus: "connected" },
        { id: "healthy", label: "Healthy host", loading: false, error: "", connectionStatus: "connected" },
      ],
    } }); flushSync();
    expect(target.querySelectorAll('[role="alert"]')).toHaveLength(2);
    expect(target.textContent).toContain("Permission denied"); expect(target.textContent).toContain("Catalog unavailable");
    expect(target.querySelector('[role="status"]')?.textContent).toContain("Loading host:");
    expect(target.querySelector('[role="status"]')?.textContent).toContain("Loading repositories");
    target.querySelector<HTMLButtonElement>('[aria-label="Retry First host repositories"]')!.click();
    expect(retry).toHaveBeenCalledExactlyOnceWith("a");
    target.querySelector<HTMLButtonElement>('[aria-label="Healthy repo, Healthy host, /repo"]')!.click();
    expect(open).toHaveBeenCalledExactlyOnceWith({ environmentId: "healthy", repositoryId: "repo" });
    expect(target.querySelector('[aria-label="Retry Healthy host repositories"]')).toBeNull();
  });

  it("pins the chosen environment for Open and keeps connection errors visible", async () => {
    const target = document.createElement("div"); document.body.append(target);
    const open = vi.fn(), retry = vi.fn();
    component = mount(StartView, { target, props: {
      repositories: [], groupedRepositories: [], loading: false, error: "Connection interrupted", connectionError: true,
      onChooseRepository: vi.fn(), onCreateRepository: vi.fn(), onRemoveRepository: vi.fn(), onOpenRepository: vi.fn(),
      onOpenScopedRepository: vi.fn(), onRetryConnection: retry, onChooseRepositoryForEnvironment: open,
      environments: [{ id: "a", label: "Local", primary: true, canOpen: true, canCreate: true }, { id: "b", label: "Remote", primary: false, canOpen: true, canCreate: false }],
    } });
    flushSync();
    const select = target.querySelector<HTMLSelectElement>("#repository-operation-environment")!;
    select.value = "b"; select.dispatchEvent(new Event("change", { bubbles: true })); await tick(); flushSync();
    [...target.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Open")!.click();
    expect(open).toHaveBeenCalledWith("b");
    expect([...target.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Create")?.disabled).toBe(true);
    expect(target.textContent).toContain("Connection interrupted");
    [...target.querySelectorAll("button")].find((button) => button.textContent?.includes("Retry connection"))!.click();
    expect(retry).toHaveBeenCalledOnce();
  });
});
