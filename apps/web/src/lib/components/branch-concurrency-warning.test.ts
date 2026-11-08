// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import DeleteBranchDialog from "./DeleteBranchDialog.svelte";
import GitNameDialog from "./GitNameDialog.svelte";
import RemoveWorktreeDialog from "./RemoveWorktreeDialog.svelte";

vi.mock("@lucide/svelte", () => ({ X: () => {} }));
let component: ReturnType<typeof mount> | undefined;
afterEach(async () => { if (component) await unmount(component); component = undefined; document.body.replaceChildren(); });

describe("branch concurrency warning", () => {
  it.each([false, true])("explains deletion risk and associates it with the dialog (force: %s)", (force) => {
    component = mount(DeleteBranchDialog, { target: document.body, props: {
      open: true, branchName: "topic", force, loading: false, error: "", onConfirm: vi.fn(), onCancel: vi.fn(),
    } });
    flushSync();
    const dialog = document.querySelector("dialog")!;
    expect(dialog.textContent).toContain("a newer branch may be deleted");
    expect(dialog.getAttribute("aria-describedby")).toContain("delete-branch-concurrency");
    expect(dialog.textContent?.includes("Unmerged commits")).toBe(force);
  });

  it.each(["branch", "renameBranch"] as const)("shows the rename risk only when renaming (%s)", (kind) => {
    component = mount(GitNameDialog, { target: document.body, props: {
      open: true, kind, value: "topic", onValueChange: vi.fn(), onSubmit: vi.fn(), onCancel: vi.fn(),
    } });
    flushSync();
    const dialog = document.querySelector("dialog")!;
    expect(dialog.textContent?.includes("the newer branch may be renamed")).toBe(kind === "renameBranch");
    expect(dialog.getAttribute("aria-describedby")).toBe(kind === "renameBranch" ? "rename-branch-concurrency" : null);
  });

  it.each([false, true])("shows branch deletion risk only when also deleting the branch (%s)", (deleteBranch) => {
    component = mount(RemoveWorktreeDialog, { target: document.body, props: {
      open: true, path: "/repo/worktree", branch: "topic", deleteBranch, forceBranchDeletion: false,
      loading: false, error: "", onConfirm: vi.fn(), onCancel: vi.fn(),
    } });
    flushSync();
    const dialog = document.querySelector("dialog")!;
    expect(dialog.textContent?.includes("a newer branch may be deleted")).toBe(deleteBranch);
    expect(dialog.getAttribute("aria-describedby")?.includes("remove-worktree-branch-concurrency")).toBe(deleteBranch);
  });
});
