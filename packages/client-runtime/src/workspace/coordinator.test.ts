import { describe, expect, it } from "vitest";
import { WorkspaceTabCoordinator } from "./coordinator.ts";
import type { RepositoryTabs } from "./tabs.ts";

const ref = (environmentId: string, repositoryId: string) => ({ environmentId, repositoryId });
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
const ready = async () => {};

describe("application workspace coordinator", () => {
  it("checks conditional close after an already queued switch commits", async () => {
    const writing = deferred(), gate = deferred();
    const old = ref("a", "old"), next = ref("b", "new");
    const initial = { tabs: [{ tabId: "tab", target: old }], activeTabId: "tab" };
    let saved: RepositoryTabs = initial;
    const coordinator = new WorkspaceTabCoordinator(initial, async (state) => {
      writing.release(); await gate.promise; saved = state;
    });
    const switching = coordinator.switch("tab", "b", async () => next, ready);
    await writing.promise;
    // The old checkout is still published here. A caller-side check is unsafe.
    const closing = coordinator.closeIfMatches("tab", old);
    gate.release(); await switching; await closing;
    expect(saved.tabs[0].target).toEqual(next);
    expect(coordinator.state.tabs[0].target).toEqual(next);
    await coordinator.closeIfMatches("tab", next);
    expect(coordinator.state.tabs).toEqual([]);
  });

  it("aborts a switch while persistence is in flight and restores durable state", async () => {
    const writing = deferred(), gate = deferred();
    const initial = { tabs: [{ tabId: "tab", target: ref("a", "old") }], activeTabId: "tab" };
    let saved: RepositoryTabs = initial;
    const coordinator = new WorkspaceTabCoordinator(initial, async (state) => { writing.release(); await gate.promise; saved = state; });
    const abort = new AbortController();
    const pending = coordinator.switch("tab", "b", async () => ref("b", "new"), ready, abort.signal);
    await writing.promise; abort.abort(); gate.release();
    await expect(pending).rejects.toThrow("no longer current");
    expect(saved).toEqual(initial);
    expect(coordinator.state).toEqual(initial);
    await coordinator.open("other", "b", async () => ref("b", "new"), ready);
    expect(coordinator.state.tabs).toHaveLength(2);
  });
  it("does not publish or retain a transition invalidated during persistence", async () => {
    const gate = deferred(), writing = deferred();
    const origin = { tabId: "source", target: ref("a", "old") };
    let saved: RepositoryTabs = { tabs: [origin], activeTabId: "source" };
    let first = true;
    const coordinator = new WorkspaceTabCoordinator(saved, async (state) => {
      if (first) { first = false; writing.release(); await gate.promise; }
      saved = state;
    });
    const published: string[][] = [];
    coordinator.subscribe((state) => published.push(state.tabs.map((tab) => tab.tabId)));
    const pending = coordinator.open("new", "b", async () => ref("b", "repo"), ready, origin);
    await writing.promise;
    const closing = coordinator.close("source");
    gate.release();
    await expect(pending).rejects.toThrow("no longer current");
    await closing;
    expect(saved.tabs).toEqual([]);
    expect(published).toEqual([["source"], []]);
  });
  it("cancels a new-tab request when its source tab closes", async () => {
    const gate = deferred();
    const origin = { tabId: "source", target: ref("a", "old") };
    const coordinator = new WorkspaceTabCoordinator({ tabs: [origin], activeTabId: "source" }, () => {});
    const pending = coordinator.open("new", "b", async () => ref("b", "repo"), () => gate.promise, origin);
    await Promise.resolve();
    await coordinator.close("source");
    await coordinator.open("other", "b", async () => ref("b", "repo"), ready);
    gate.release();
    await expect(pending).rejects.toThrow("no longer current");
    expect(coordinator.state.tabs.map((tab) => tab.tabId)).toEqual(["other"]);
  });
  it("allows equal IDs in different environments and rejects duplicates while preparing", async () => {
    const gate = deferred();
    const coordinator = new WorkspaceTabCoordinator({ tabs: [], activeTabId: null }, () => {});
    const first = coordinator.open("one", "a", async () => ref("a", "id"), () => gate.promise);
    await Promise.resolve();
    await expect(coordinator.open("two", "a", async () => ref("a", "id"), ready)).rejects.toThrow("already open");
    await coordinator.open("three", "b", async () => ref("b", "id"), ready);
    gate.release(); await first;
    expect(coordinator.state.tabs).toHaveLength(2);
  });

  it("keeps the old tab on failed save and releases its reservation", async () => {
    let fail = true;
    const coordinator = new WorkspaceTabCoordinator({ tabs: [{ tabId: "one", target: ref("a", "old") }], activeTabId: "one" }, () => { if (fail) throw new Error("quota"); });
    await expect(coordinator.switch("one", "a", async () => ref("a", "new"), ready)).rejects.toThrow("quota");
    expect(coordinator.state.tabs[0].target).toEqual(ref("a", "old"));
    fail = false;
    await coordinator.switch("one", "a", async () => ref("a", "new"), ready);
    expect(coordinator.state.tabs[0].target).toEqual(ref("a", "new"));
  });

  it("invalidates a delayed switch after close or environment removal", async () => {
    for (const action of ["close", "remove"] as const) {
      const gate = deferred();
      const coordinator = new WorkspaceTabCoordinator({ tabs: [{ tabId: "one", target: ref("a", "old") }], activeTabId: "one" }, () => {});
      const pending = coordinator.switch("one", "b", async () => ref("b", "new"), () => gate.promise);
      await Promise.resolve();
      if (action === "close") await coordinator.close("one"); else await coordinator.removeEnvironment("b");
      gate.release();
      await expect(pending).rejects.toThrow("no longer current");
      expect(coordinator.state.tabs.some((tab) => tab.target.environmentId === "b")).toBe(false);
    }
  });

  it("releases a cancelled reservation without releasing a newer owner's reservation", async () => {
    const firstGate = deferred(), secondGate = deferred();
    const coordinator = new WorkspaceTabCoordinator({ tabs: [{ tabId: "source", target: ref("a", "old") }], activeTabId: "source" }, () => {});
    const first = coordinator.switch("source", "b", async () => ref("b", "new"), () => firstGate.promise);
    await Promise.resolve();
    await coordinator.close("source");
    const second = coordinator.open("second", "b", async () => ref("b", "new"), () => secondGate.promise);
    await Promise.resolve();
    firstGate.release();
    await expect(first).rejects.toThrow("no longer current");
    await expect(coordinator.open("third", "b", async () => ref("b", "new"), ready)).rejects.toThrow("already open");
    secondGate.release();
    await second;
    expect(coordinator.state.tabs.map((tab) => tab.tabId)).toEqual(["second"]);
  });

  it("invalidates a switch when its source environment is removed", async () => {
    const gate = deferred();
    const coordinator = new WorkspaceTabCoordinator({ tabs: [{ tabId: "source", target: ref("a", "old") }], activeTabId: "source" }, () => {});
    const pending = coordinator.switch("source", "b", async () => ref("b", "new"), () => gate.promise);
    await Promise.resolve();
    await coordinator.removeEnvironment("a");
    await coordinator.open("other", "b", async () => ref("b", "new"), ready);
    gate.release();
    await expect(pending).rejects.toThrow("no longer current");
    expect(coordinator.state.tabs.map((tab) => tab.tabId)).toEqual(["other"]);
  });
});
