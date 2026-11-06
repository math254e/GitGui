// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import RepositoryRouteHarness from "./RepositoryRoute.test-harness.svelte";
import type { RepositoryPageModel, RepositoryRouteSnapshot } from "$lib/workspace/repository-routing";
import { resolveDeepLinkTarget } from "$lib/workspace/deep-links";
import { repositoryRouteFromParams, REPOSITORY_ROUTE_ID, SCOPED_REPOSITORY_ROUTE_ID, type RepositoryRouteRequest } from "$lib/workspace/routes";

vi.mock("./RepositoryPage.svelte", () => import("./RepositoryPage.test-fixture.svelte"));

let mounted: { update: (request: RepositoryRouteRequest, snapshot: RepositoryRouteSnapshot) => void } | undefined;
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  document.body.replaceChildren();
});

describe("mounted repository route", () => {
  const a = { environmentId: "a", repositoryId: "same" };
  const b = { environmentId: "b", repositoryId: "same" };
  const scoped = (target = a) => repositoryRouteFromParams(SCOPED_REPOSITORY_ROUTE_ID, target)!;
  function fixture() {
    const fetch = vi.fn(async () => {});
    const release = vi.fn();
    const model = (environmentId: string) => ({
      stashContextKey: environmentId + ":same", fetchRepository: fetch, closeDiff: release,
    } as unknown as RepositoryPageModel);
    const aView = model("a"), bView = model("b");
    const base: RepositoryRouteSnapshot = {
      ready: true, legacyCatalogsReady: true, environmentIds: ["a", "b"],
      candidates: [
        { target: a, environmentLabel: "Local", path: "/local/repo" },
        { target: b, environmentLabel: "Remote", path: "/remote/repo" },
      ],
      openTargets: [a, b], activeTarget: a, view: aView,
    };
    const activate = vi.fn(async () => {});
    const navigate = vi.fn();
    return { fetch, release, aView, bView, base, activate, navigate };
  }

  it("mounts one shared presentation, selects across history and releases equal-ID views across hosts", async () => {
    const f = fixture();
    mounted = mount(RepositoryRouteHarness, { target: document.body, props: {
      initialRequest: scoped(), initialSnapshot: f.base, activate: f.activate, navigate: f.navigate,
    } });
    flushSync(); await Promise.resolve(); flushSync();
    expect(document.querySelectorAll('[data-testid="repository-presentation"]')).toHaveLength(1);
    expect(document.body.textContent).toBe("a:same");
    expect(f.fetch).toHaveBeenCalledTimes(1);
    // A new snapshot must not remount the current presentation.
    flushSync(() => mounted!.update(scoped(), { ...f.base }));
    expect(f.fetch).toHaveBeenCalledTimes(1);
    flushSync(() => mounted!.update(scoped(b), f.base));
    await Promise.resolve(); flushSync();
    expect(f.activate).toHaveBeenCalledExactlyOnceWith(b, expect.anything());
    expect(document.body.textContent).not.toContain("a:same");
    flushSync(() => mounted!.update(scoped(b), { ...f.base, activeTarget: b, view: f.bView }));
    await Promise.resolve(); flushSync();
    expect(document.body.textContent).toBe("b:same");
    expect(f.release).toHaveBeenCalledTimes(1);
    // Simulate browser back, then its matching coordinator publication.
    flushSync(() => mounted!.update(scoped(), { ...f.base, activeTarget: b, view: f.bView }));
    await Promise.resolve(); flushSync();
    expect(f.activate).toHaveBeenLastCalledWith(a, expect.anything());
    flushSync(() => mounted!.update(scoped(), f.base));
    await Promise.resolve(); flushSync();
    expect(document.body.textContent).toBe("a:same");
    await unmount(mounted); mounted = undefined;
    expect(f.fetch).toHaveBeenCalledTimes(3);
    expect(f.release).toHaveBeenCalledTimes(3);
    expect(f.navigate).not.toHaveBeenCalled();
  });

  it("shows legacy deep-link ambiguity and replaces it only after an explicit location choice", async () => {
    const f = fixture();
    expect(resolveDeepLinkTarget("gitgui://repo/same")).toBe("/repo/same");
    const request = repositoryRouteFromParams(REPOSITORY_ROUTE_ID, { repositoryId: "same" })!;
    mounted = mount(RepositoryRouteHarness, { target: document.body, props: {
      initialRequest: request, initialSnapshot: f.base, activate: f.activate, navigate: f.navigate,
    } });
    flushSync(); await Promise.resolve();
    expect(document.body.textContent).toContain("Choose a repository location");
    expect(document.body.textContent).toContain("/remote/repo");
    expect(f.activate).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    const remote = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Remote"))!;
    remote.click();
    expect(f.navigate).toHaveBeenCalledExactlyOnceWith("/repo/b/same", { replaceState: true });
  });

  it("replaces the closed active route without a reopen or duplicate mount", async () => {
    const f = fixture();
    mounted = mount(RepositoryRouteHarness, { target: document.body, props: {
      initialRequest: scoped(), initialSnapshot: f.base, activate: f.activate, navigate: f.navigate,
    } });
    flushSync(); await Promise.resolve(); flushSync();
    const closed = { ...f.base, openTargets: [b], activeTarget: b, view: f.bView };
    flushSync(() => mounted!.update(scoped(), closed));
    flushSync(() => mounted!.update(scoped(), { ...closed }));
    await Promise.resolve();
    expect(f.navigate).toHaveBeenCalledExactlyOnceWith("/repo/b/same", { replaceState: true });
    expect(f.activate).not.toHaveBeenCalled();
    expect(document.querySelectorAll('[data-testid="repository-presentation"]')).toHaveLength(0);
    expect(f.release).toHaveBeenCalledTimes(1);
  });
});
