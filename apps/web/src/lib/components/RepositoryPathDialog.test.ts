// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import RepositoryPathDialog from "./RepositoryPathDialog.svelte";

vi.mock("@lucide/svelte", () => ({ FolderOpen: () => {}, X: () => {} }));

let component: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (component) await unmount(component);
  document.body.replaceChildren();
});

function render(options: { loading?: boolean; allowCancelWhileLoading?: boolean; canOpen?: boolean } = {}) {
  const cancel = vi.fn(), submit = vi.fn();
  component = mount(RepositoryPathDialog, { target: document.body, props: {
    open: true, value: "/srv/repositories/project", environmentLabel: "Build host",
    canOpen: true, ...options, onValueChange: vi.fn(), onSubmit: submit, onCancel: cancel,
  } });
  flushSync();
  return { dialog: document.querySelector("dialog")!, cancel, submit };
}

describe("host repository path dialog", () => {
  it("opens as a native modal, names the host, and cancels without a filesystem picker", () => {
    const { dialog, cancel } = render();
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain("Enter a path on Build host.");
    expect(dialog.querySelector('input[type="file"]')).toBeNull();
    const event = new Event("cancel", { cancelable: true });
    dialog.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([false, true])("preserves cancellation ownership during a pending open (allowed: %s)", (allowCancelWhileLoading) => {
    const { dialog, cancel } = render({ loading: true, allowCancelWhileLoading });
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(cancel).toHaveBeenCalledTimes(allowCancelWhileLoading ? 1 : 0);
    expect(dialog.querySelector<HTMLInputElement>("input")!.disabled).toBe(true);
  });

  it("does not submit when host authorization is unavailable", () => {
    const { dialog, submit } = render({ canOpen: false });
    dialog.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(submit).not.toHaveBeenCalled();
    expect(dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  });
});
