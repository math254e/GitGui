// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import Harness from "$lib/components/Component.test-harness.svelte";
import RepositoryPage from "./RepositoryPage.svelte";
import type { RepositoryPageModel } from "$lib/workspace/repository-routing";

const readers = vi.hoisted(() => ({ details: [] as Record<string, unknown>[], diff: [] as Record<string, unknown>[] }));
vi.mock("$lib/diff/renderer", () => ({ acquireDiffRenderer: () => ({ ready: Promise.resolve({}), release() {} }) }));
vi.mock("$lib/components/CommitDetailsPanel.svelte", () => ({ default: (_anchor: unknown, props: Record<string, unknown>) => { readers.details.push(props); } }));
vi.mock("$lib/components/CommitFileDiffViewer.svelte", () => ({ default: (_anchor: unknown, props: Record<string, unknown>) => { readers.diff.push(props); } }));
vi.mock("$lib/components/StashDetailsPanel.svelte", () => ({ default: () => {} }));
vi.mock("$lib/components/StashReviewDialog.svelte", () => ({ default: () => {} }));
vi.mock("$lib/components/EmptyDetailsPanel.svelte", () => ({ default: () => {} }));
vi.mock("$lib/components/GitGraph.svelte", () => ({ default: () => {} }));
vi.mock("$lib/components/HistoryToolbar.svelte", () => ({ default: () => {} }));
vi.mock("$lib/components/RepositoryDetailsPanel.svelte", () => ({ default: () => {} }));
vi.mock("$lib/components/Sidebar.svelte", () => ({ default: () => {} }));
vi.mock("$lib/components/StartView.svelte", () => ({ default: () => {} }));
vi.mock("$lib/components/WorkingTreePanel.svelte", () => ({ default: () => {} }));

let component: { update(value: Record<string, unknown>): void } | undefined;
afterEach(async () => { if (component) await unmount(component); component = undefined; document.body.replaceChildren(); readers.details.length = 0; readers.diff.length = 0; });

function model(largeScreen: boolean) {
  return {
    activeRepository: { title: "Restored repository" }, activeRepositoryId: "same", snapshot: null,
    largeScreen, stashReview: null, activeEnvironmentGeneration: 1,
    repositoryAvailability: { environmentLabel: "Remote host", title: "Environment offline", detail: "Reconnect to load this repository.", canRetry: true },
    retryActiveRepository: vi.fn(),
    largeScreenPanes: [{ id: "sidebar", minWidth: 180 }, { id: "graph", minWidth: 200, flexible: true }, { id: "details", minWidth: 300 }],
  } as unknown as RepositoryPageModel;
}

describe("repository page scoped availability and read identity", () => {
  it("shows an offline status while retaining a previously loaded snapshot", () => {
    const store = { ...model(false), snapshot: {}, repositoryDisconnected: true, gitActionPending: true };
    component = mount(Harness, { target: document.body, props: { component: RepositoryPage, initialProps: { store } } });
    flushSync();
    expect(document.body.textContent).toContain("Environment offline. Showing saved data.");
    document.querySelector<HTMLButtonElement>("button")!.click();
    expect(store.retryActiveRepository).toHaveBeenCalledOnce();
  });
  it.each([false, true])("shows a scoped restored-tab retry and a temporary loading state (large: %s)", (largeScreen) => {
    const store = model(largeScreen);
    component = mount(Harness, { target: document.body, props: { component: RepositoryPage, initialProps: { store } } });
    flushSync();
    expect(document.body.textContent).toContain("Remote host · Restored repository");
    expect(document.body.textContent).toContain("Environment offline");
    document.querySelector<HTMLButtonElement>("button")!.click();
    expect(store.retryActiveRepository).toHaveBeenCalledOnce();
    component.update({ store: { ...store, repositoryAvailability: { ...store.repositoryAvailability,
      title: "Loading repository…", detail: "Waiting for the repository snapshot.", canRetry: false,
    } } }); flushSync();
    expect(document.body.textContent).toContain("Loading repository…");
    expect(document.body.textContent).not.toContain("Environment offline");
    expect(document.querySelector("button")).toBeNull();
  });

  it.each([false, true])("passes replacement generations to both mounted detail readers (large: %s)", (largeScreen) => {
    const store = { ...model(largeScreen), snapshot: {}, selectedCommit: { hash: "commit" }, selectedFile: { path: "file.ts" },
      client: {}, selectedStash: null, changesSelected: false };
    component = mount(Harness, { target: document.body, props: { component: RepositoryPage, initialProps: { store } } });
    flushSync();
    expect(readers.details).toHaveLength(1); expect(readers.diff).toHaveLength(1);
    expect(readers.details[0].environmentGeneration).toBe(1); expect(readers.diff[0].environmentGeneration).toBe(1);
    component.update({ store: { ...store, activeEnvironmentGeneration: 2 } }); flushSync();
    expect(readers.details[0].environmentGeneration).toBe(2); expect(readers.diff[0].environmentGeneration).toBe(2);
    expect(readers.details).toHaveLength(1); expect(readers.diff).toHaveLength(1);
    expect(document.body.textContent).not.toContain("Environment offline");
  });
});
