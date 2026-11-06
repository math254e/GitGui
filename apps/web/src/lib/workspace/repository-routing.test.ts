import { describe, expect, it, vi } from "vitest";
import {
  RepositoryRouteController,
  resolveLegacyRepositoryTarget,
  resolveClosedScopedRepositoryTarget,
  type RepositoryPageModel,
  type RepositoryRouteAdapter,
  type RepositoryRouteSnapshot,
  type RepositoryRouteState,
} from "./repository-routing";

describe("legacy repository links", () => {
  const a = { environmentId: "a", repositoryId: "same" };
  const b = { environmentId: "b", repositoryId: "same" };
  it("requires a choice for equal IDs on different environments unless the legacy selection resolves it", () => {
    expect(resolveLegacyRepositoryTarget("same", [a, b])).toEqual({ kind: "ambiguous", targets: [a, b] });
    expect(resolveLegacyRepositoryTarget("same", [a, b], "b")).toEqual({ kind: "found", target: b });
    expect(resolveLegacyRepositoryTarget("same", [a, a], "missing")).toEqual({ kind: "found", target: a });
    expect(resolveLegacyRepositoryTarget("other", [a, b])).toEqual({ kind: "missing" });
  });
});
import {
  resolveClosedRepositoryTarget,
  resolveRouteIntent,
} from "./repository-routing";

describe("route intent", () => {
  it("does nothing when the route points at no repository", () => {
    expect(
      resolveRouteIntent({
        routedRepositoryId: null,
        openRepositoryIds: ["repo-a"],
        activeRepositoryId: "repo-a",
      }),
    ).toEqual({ kind: "none" });
  });

  it("opens a repository the workspace does not have open", () => {
    expect(
      resolveRouteIntent({
        routedRepositoryId: "repo-b",
        openRepositoryIds: ["repo-a"],
        activeRepositoryId: "repo-a",
      }),
    ).toEqual({ kind: "open", repositoryId: "repo-b" });
  });

  it("selects an open repository that is not the active one", () => {
    expect(
      resolveRouteIntent({
        routedRepositoryId: "repo-b",
        openRepositoryIds: ["repo-a", "repo-b"],
        activeRepositoryId: "repo-a",
      }),
    ).toEqual({ kind: "select", repositoryId: "repo-b" });
  });

  it("does nothing when the routed repository is already active", () => {
    expect(
      resolveRouteIntent({
        routedRepositoryId: "repo-a",
        openRepositoryIds: ["repo-a", "repo-b"],
        activeRepositoryId: "repo-a",
      }),
    ).toEqual({ kind: "none" });
  });
});

describe("closed repository target", () => {
  it("moves to the next open repository", () => {
    expect(resolveClosedRepositoryTarget("repo-b")).toBe("/repo/repo-b");
  });

  it("moves to the repositories home page when the last tab closes", () => {
    expect(resolveClosedRepositoryTarget(null)).toBe("/");
  });
});

describe("scoped route lifetime", () => {
  const a = { environmentId: "a", repositoryId: "same" };
  const b = { environmentId: "b", repositoryId: "same" };
  const route = (target = a) => ({ kind: "scoped" as const, target });
  const view = {} as RepositoryPageModel;
  const snapshot = (overrides: Partial<RepositoryRouteSnapshot> = {}): RepositoryRouteSnapshot => ({
    ready: true,
    environmentIds: ["a", "b"],
    legacyCatalogsReady: true,
    candidates: [a, b].map((target) => ({ target, environmentLabel: target.environmentId, path: "/" + target.environmentId })),
    openTargets: [],
    activeTarget: null,
    view: null,
    ...overrides,
  });
  function setup(activate = vi.fn<RepositoryRouteAdapter["activate"]>(async () => {})) {
    const onState = vi.fn<(state: RepositoryRouteState) => void>();
    const navigate = vi.fn();
    const controller = new RepositoryRouteController({ activate }, onState, navigate);
    return { controller, activate, onState, navigate };
  }
  const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

  it("waits for restored metadata, then activates the exact scoped target once", async () => {
    const { controller, activate, onState } = setup();
    controller.update(route(b), snapshot({ ready: false }));
    await tick();
    expect(activate).not.toHaveBeenCalled();
    controller.update(route(b), snapshot({ activeTarget: a, openTargets: [a], view }));
    controller.update(route(b), snapshot({ activeTarget: a, openTargets: [a], view }));
    await tick();
    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate.mock.calls[0]).toEqual([b, { signal: expect.any(AbortSignal) }]);
    expect(onState).toHaveBeenLastCalledWith({ kind: "loading" });
    controller.update(route(b), snapshot({ activeTarget: b, openTargets: [a, b], view }));
    expect(onState).toHaveBeenLastCalledWith({ kind: "ready", target: b });
    controller.dispose();
  });

  it("selects a matching open tab once and never treats equal IDs on another host as that tab", async () => {
    const { controller, activate } = setup();
    controller.update(route(b), snapshot({ openTargets: [a, b], activeTarget: a, view }));
    await tick();
    expect(activate).toHaveBeenCalledWith(b, expect.anything());
    controller.update(route(b), snapshot({ openTargets: [a, b], activeTarget: b, view }));
    expect(activate).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("does not activate a tab already selected or an unregistered environment", async () => {
    const { controller, activate, onState } = setup();
    controller.update(route(), snapshot({ openTargets: [a], activeTarget: a, view }));
    await tick();
    expect(activate).not.toHaveBeenCalled();
    controller.update(route({ ...a, environmentId: "removed" }), snapshot());
    await tick();
    expect(activate).not.toHaveBeenCalled();
    expect(onState).toHaveBeenLastCalledWith({ kind: "missing", message: "This environment is no longer registered." });
    controller.dispose();
  });

  it("requires a legacy choice even when one of the colliding tabs is active", async () => {
    const { controller, activate, onState } = setup();
    controller.update({ kind: "legacy", repositoryId: "same" }, snapshot({ openTargets: [a], activeTarget: a, view }));
    await tick();
    expect(activate).not.toHaveBeenCalled();
    expect(onState).toHaveBeenLastCalledWith({ kind: "ambiguous", candidates: snapshot().candidates });
    controller.update({ kind: "legacy", repositoryId: "same" }, snapshot({ legacySelectedEnvironmentId: "b" }));
    await tick();
    expect(activate).toHaveBeenCalledWith(b, expect.anything());
    controller.dispose();
  });

  it("does not guess from one cached match while another known catalog is still unknown", async () => {
    const { controller, activate, onState } = setup();
    const input = { kind: "legacy" as const, repositoryId: "same" };
    controller.update(input, snapshot({ candidates: snapshot().candidates.slice(0, 1), legacyCatalogsReady: false }));
    await tick();
    expect(activate).not.toHaveBeenCalled();
    expect(onState).toHaveBeenLastCalledWith({ kind: "loading" });
    controller.update(input, snapshot({ legacyCatalogsReady: false }));
    expect(onState).toHaveBeenLastCalledWith({ kind: "ambiguous", candidates: snapshot().candidates });
    controller.dispose();
  });

  it("honors a captured saved mapping without waiting for unrelated offline catalogs", async () => {
    const { controller, activate } = setup();
    controller.update({ kind: "legacy", repositoryId: "same" }, snapshot({
      candidates: snapshot().candidates.slice(0, 1), legacyCatalogsReady: false, legacySelectedEnvironmentId: "a",
    }));
    await tick();
    expect(activate).toHaveBeenCalledWith(a, expect.anything());
    controller.dispose();
  });

  it("replaces the closed route with the surviving scoped tab and never reopens through state updates", async () => {
    const { controller, activate, navigate } = setup();
    controller.update(route(), snapshot({ openTargets: [a, b], activeTarget: a, view }));
    controller.update(route(), snapshot({ openTargets: [b], activeTarget: b, view }));
    controller.update(route(), snapshot({ openTargets: [b], activeTarget: b, view }));
    await tick();
    expect(activate).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledExactlyOnceWith(b);
    expect(resolveClosedScopedRepositoryTarget(b)).toBe("/repo/b/same");
    expect(resolveClosedScopedRepositoryTarget(null)).toBe("/");
    // Back/forward after visiting the survivor is an intentional new entry.
    controller.update(route(b), snapshot({ openTargets: [b], activeTarget: b, view }));
    controller.update(route(), snapshot({ openTargets: [b], activeTarget: b, view }));
    await tick();
    expect(activate).toHaveBeenCalledExactlyOnceWith(a, expect.anything());
    controller.dispose();
  });

  it("aborts old route activation and ignores late failure after navigating to a different host", async () => {
    let reject!: (error: Error) => void;
    const activate = vi.fn().mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail; }))
      .mockResolvedValue(undefined);
    const { controller, onState, navigate } = setup(activate);
    controller.update(route(), snapshot());
    await tick();
    const oldSignal = activate.mock.calls[0][1].signal as AbortSignal;
    controller.update(route(b), snapshot({ openTargets: [b], activeTarget: b, view }));
    expect(oldSignal.aborted).toBe(true);
    reject(new Error("late a failure"));
    await tick();
    expect(onState).toHaveBeenLastCalledWith({ kind: "ready", target: b });
    expect(navigate).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("does not dispatch an activation superseded before its first asynchronous step", async () => {
    const { controller, activate } = setup();
    controller.update(route(), snapshot());
    controller.update(route(b), snapshot());
    await tick();
    expect(activate).toHaveBeenCalledExactlyOnceWith(b, expect.anything());
    controller.dispose();
  });

  it("replaces the last closed tab with home exactly once", async () => {
    const { controller, activate, navigate } = setup();
    controller.update(route(), snapshot({ openTargets: [a], activeTarget: a, view }));
    controller.update(route(), snapshot());
    controller.update(route(), snapshot());
    await tick();
    expect(activate).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledExactlyOnceWith(null);
    controller.dispose();
  });

  it("waits for tab cleanup after environment removal and navigates to the survivor", () => {
    const { controller, navigate, onState } = setup();
    controller.update(route(), snapshot({ openTargets: [a, b], activeTarget: a, view }));
    controller.update(route(), snapshot({ environmentIds: ["b"], openTargets: [a, b], activeTarget: a, view }));
    expect(onState).toHaveBeenLastCalledWith({ kind: "loading" });
    controller.update(route(), snapshot({ environmentIds: ["b"], openTargets: [b], activeTarget: b, view }));
    expect(navigate).toHaveBeenCalledExactlyOnceWith(b);
    controller.dispose();
  });

  it("aborts on close, environment removal and unmount", async () => {
    for (const reason of ["close", "remove", "unmount"]) {
      const activate = vi.fn<RepositoryRouteAdapter["activate"]>(() => new Promise<void>(() => {}));
      const { controller } = setup(activate);
      controller.update(route(), snapshot({ openTargets: [a], activeTarget: b, view }));
      await tick();
      const signal = activate.mock.calls[0][1].signal as AbortSignal;
      if (reason === "close") controller.update(route(), snapshot());
      if (reason === "remove") controller.update(route(), snapshot({ environmentIds: ["b"] }));
      if (reason === "unmount") controller.dispose();
      expect(signal.aborted).toBe(true);
      controller.dispose();
    }
  });

  it("reports activation errors once and retries only on explicit request", async () => {
    const activate = vi.fn().mockRejectedValueOnce(new Error("permission denied")).mockResolvedValue(undefined);
    const { controller, onState } = setup(activate);
    controller.update(route(), snapshot());
    await tick();
    controller.update(route(), snapshot());
    expect(activate).toHaveBeenCalledTimes(1);
    expect(onState).toHaveBeenLastCalledWith({ kind: "error", message: "permission denied" });
    controller.retry();
    await tick();
    expect(activate).toHaveBeenCalledTimes(2);
    controller.dispose();
  });
});
