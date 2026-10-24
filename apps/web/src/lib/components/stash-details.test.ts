// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import type { GitGuiClient } from "@gitgui/client-runtime";
import type { CommitFile, GitStashFilesResult, StashInfo } from "@gitgui/contracts";
import StashDetailsLifecycle from "./__tests__/StashDetailsLifecycle.svelte";
import { stashFilesCache } from "$lib/workspace/stash-files-cache";

const stash: StashInfo = { selector: "stash@{0}", hash: "a".repeat(40), message: "Saved", baseHash: "b".repeat(40), indexHash: null, branch: "main", timestamp: 1 };
const file: CommitFile = { path: "src/one", status: "M", originalPath: null };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function client() {
  return { serverWelcome: { capabilities: ["git.stash.files"] }, getStashFiles: vi.fn<GitGuiClient["getStashFiles"]>() };
}
let component: { update(next: Partial<{ client: GitGuiClient; repositoryId: string; stash: StashInfo }>): void } | undefined;
afterEach(async () => { if (component) await unmount(component); component = undefined; document.body.replaceChildren(); });
function setup(mock: ReturnType<typeof client>, entry = stash, repositoryId = "repo") {
  const target = document.createElement("div"); document.body.append(target);
  component = mount(StashDetailsLifecycle, { target, props: { client: mock as unknown as GitGuiClient, repositoryId, stash: entry } });
  flushSync();
  return target;
}
function tree(target: HTMLElement) { return [...target.querySelectorAll("div")].find((node) => node.shadowRoot)!; }

describe("fast stash details", () => {
  it("shows cached files immediately, verifies the current selector and preserves the tree on equal results", async () => {
    const mock = client(), pending = deferred<GitStashFilesResult>();
    stashFilesCache(mock as unknown as GitGuiClient).put("repo", stash.hash, [file]);
    mock.getStashFiles.mockReturnValue(pending.promise);
    const target = setup(mock);
    expect(target.textContent).toContain("1 saved file");
    expect(target.textContent).not.toContain("Loading saved files");
    expect(mock.getStashFiles).toHaveBeenCalledWith({ repositoryId: "repo", target: { selector: stash.selector, expectedOid: stash.hash } }, expect.any(AbortSignal));
    const originalTree = tree(target);
    component!.update({ stash: { ...stash, message: "Updated metadata" } }); flushSync();
    expect(mock.getStashFiles).toHaveBeenCalledTimes(1);
    pending.resolve({ stash, files: [{ ...file }] }); await tick(); await tick();
    expect(tree(target)).toBe(originalTree);
    expect(originalTree.isConnected).toBe(true);
    expect(target.textContent).toContain("Updated metadata");
  });

  it("reuses immutable files after reindexing but rechecks the new selector and clears failed verification", async () => {
    const mock = client();
    mock.getStashFiles.mockResolvedValueOnce({ stash, files: [file] });
    const target = setup(mock);
    await vi.waitFor(() => expect(target.textContent).toContain("1 saved file"));
    const originalTree = tree(target);
    const pending = deferred<GitStashFilesResult>(); mock.getStashFiles.mockReturnValueOnce(pending.promise);
    const shifted = { ...stash, selector: "stash@{1}" };
    component!.update({ stash: shifted }); flushSync();
    expect(tree(target)).toBe(originalTree);
    expect(target.textContent).not.toContain("Loading saved files");
    expect(mock.getStashFiles.mock.calls[1][0].target).toEqual({ selector: shifted.selector, expectedOid: stash.hash });
    pending.resolve({ stash, files: [file] });
    await vi.waitFor(() => expect(target.querySelector('[role="alert"]')?.textContent).toContain("The stash changed"));
    expect(originalTree.isConnected).toBe(false);
    expect(stashFilesCache(mock as unknown as GitGuiClient).get("repo", stash.hash)).toBeUndefined();
    mock.getStashFiles.mockResolvedValueOnce({ stash: shifted, files: [file] });
    target.querySelector<HTMLButtonElement>("button")!.click(); flushSync();
    expect(target.textContent).toContain("Loading saved files");
    await vi.waitFor(() => expect(target.textContent).toContain("1 saved file"));
  });

  it.each(["client", "repository"])("does not show a previous %s's cached files", async (change) => {
    const mock = client(); mock.getStashFiles.mockResolvedValueOnce({ stash, files: [file] });
    const target = setup(mock);
    await vi.waitFor(() => expect(target.textContent).toContain("1 saved file"));
    const next = client(); next.getStashFiles.mockReturnValue(new Promise(() => {}));
    mock.getStashFiles.mockReturnValue(new Promise(() => {}));
    component!.update(change === "client" ? { client: next as unknown as GitGuiClient } : { repositoryId: "other" }); flushSync();
    expect(target.textContent).toContain("Loading saved files");
    expect(target.textContent).not.toContain("1 saved file");
  });

  it("ignores superseded responses before they can populate any cache", async () => {
    const mock = client(), old = deferred<GitStashFilesResult>(), next = deferred<GitStashFilesResult>();
    mock.getStashFiles.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const target = setup(mock);
    const other = { ...stash, hash: "c".repeat(40) };
    const signal = mock.getStashFiles.mock.calls[0][1]!;
    component!.update({ stash: other }); flushSync();
    expect(signal.aborted).toBe(true);
    old.resolve({ stash, files: [file] }); await tick(); await tick();
    expect(stashFilesCache(mock as unknown as GitGuiClient).get("repo", stash.hash)).toBeUndefined();
    expect(target.textContent).toContain("Loading saved files");
    next.resolve({ stash: other, files: [file] });
    await vi.waitFor(() => expect(target.textContent).toContain("1 saved file"));
  });

  it("revisits a loaded stash immediately and removes cached data on a real read failure", async () => {
    const mock = client(); mock.getStashFiles.mockResolvedValueOnce({ stash, files: [file] });
    const target = setup(mock);
    await vi.waitFor(() => expect(target.textContent).toContain("1 saved file"));
    const other = { ...stash, hash: "c".repeat(40) };
    mock.getStashFiles.mockReturnValueOnce(new Promise(() => {}));
    component!.update({ stash: other }); flushSync();
    expect(target.textContent).toContain("Loading saved files");
    const verification = deferred<GitStashFilesResult>(); mock.getStashFiles.mockReturnValueOnce(verification.promise);
    component!.update({ stash }); flushSync();
    expect(target.textContent).toContain("1 saved file");
    verification.reject(new Error("Saved object unavailable"));
    await vi.waitFor(() => expect(target.querySelector('[role="alert"]')?.textContent).toContain("Saved object unavailable"));
    expect(target.querySelector('[aria-label="Changed files"]')).toBeNull();
    expect(stashFilesCache(mock as unknown as GitGuiClient).get("repo", stash.hash)).toBeUndefined();
  });
});
