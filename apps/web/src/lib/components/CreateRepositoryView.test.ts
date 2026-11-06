// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import CreateRepositoryView from "./CreateRepositoryView.svelte";

vi.mock("@lucide/svelte", () => ({ Cloud: () => {}, FolderPlus: () => {}, GitBranch: () => {}, HardDriveDownload: () => {}, X: () => {} }));
let component: ReturnType<typeof mount> | undefined;
afterEach(async () => { if (component) await unmount(component); component = undefined; document.body.replaceChildren(); });

describe("repository creation host context", () => {
  it("keeps host paths editable without presenting Browse as a remote picker", () => {
    const onBrowse = vi.fn(), onSubmit = vi.fn();
    component = mount(CreateRepositoryView, { target: document.body, props: {
      provider: "local", parentPath: "/srv/projects", name: "project", initialBranch: "main", initializeLfs: false,
      canBrowse: false, canCreate: true, environmentLabel: "Build host", onBrowse, onSubmit,
      onProviderChange: vi.fn(), onParentPathChange: vi.fn(), onNameChange: vi.fn(), onInitialBranchChange: vi.fn(), onInitializeLfsChange: vi.fn(), onCancel: vi.fn(),
    } }); flushSync();
    expect(document.body.textContent).toContain("On Build host");
    expect(document.querySelector("output")?.textContent).toContain("/srv/projects/project");
    const browse = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Browse")!;
    expect(browse.disabled).toBe(true);
    expect(browse.title).toContain("Enter a path on the selected host");
    browse.click(); expect(onBrowse).not.toHaveBeenCalled();
    document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});
