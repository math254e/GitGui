import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  initialize: (() => Promise.resolve()) as () => Promise<void>,
  pools: [] as { terminate: ReturnType<typeof vi.fn>; options: unknown }[],
}));
vi.mock("@pierre/diffs", () => ({}));
vi.mock("@pierre/diffs/worker/worker.js?worker", () => ({ default: class {} }));
vi.mock("@pierre/diffs/worker", () => ({
  WorkerPoolManager: class {
    terminate = vi.fn();
    constructor(public options: unknown) { mock.pools.push(this); }
    initialize() { return mock.initialize(); }
  },
}));

beforeEach(() => {
  vi.resetModules();
  mock.pools.length = 0;
  mock.initialize = () => Promise.resolve();
});

describe("repository diff renderer resources", () => {
  it("shares the warm bounded pool across viewer mounts until the page releases it", async () => {
    const { acquireDiffRenderer } = await import("./renderer");
    const page = acquireDiffRenderer();
    const first = acquireDiffRenderer();
    expect(first.ready).toBe(page.ready);
    await first.ready;
    expect(mock.pools).toHaveLength(1);
    expect(mock.pools[0].options).toMatchObject({ poolSize: 1, totalASTLRUCacheSize: 2 });
    first.release();
    first.release();
    const next = acquireDiffRenderer();
    expect(next.ready).toBe(page.ready);
    next.release();
    expect(mock.pools[0].terminate).not.toHaveBeenCalled();
    page.release();
    expect(mock.pools[0].terminate).toHaveBeenCalledOnce();
  });

  it("does not create a worker when released before module loading completes", async () => {
    const { acquireDiffRenderer } = await import("./renderer");
    const lease = acquireDiffRenderer();
    const rejected = expect(lease.ready).rejects.toMatchObject({ name: "AbortError" });
    lease.release();
    await rejected;
    expect(mock.pools).toHaveLength(0);
  });

  it("terminates pending startup and prevents an old release from disposing a replacement", async () => {
    let complete!: () => void;
    mock.initialize = () => new Promise<void>((resolve) => { complete = resolve; });
    const { acquireDiffRenderer } = await import("./renderer");
    const old = acquireDiffRenderer();
    await vi.waitFor(() => expect(mock.pools).toHaveLength(1));
    const rejected = expect(old.ready).rejects.toMatchObject({ name: "AbortError" });
    old.release();
    expect(mock.pools[0].terminate).toHaveBeenCalledOnce();
    mock.initialize = () => Promise.resolve();
    const replacement = acquireDiffRenderer();
    await replacement.ready;
    complete();
    await rejected;
    old.release();
    expect(mock.pools[1].terminate).not.toHaveBeenCalled();
    replacement.release();
    expect(mock.pools[1].terminate).toHaveBeenCalledOnce();
  });

  it("releases failed initialization and permits a fresh Retry", async () => {
    mock.initialize = () => Promise.reject(new Error("Worker startup failed"));
    const { acquireDiffRenderer } = await import("./renderer");
    const failed = acquireDiffRenderer();
    await expect(failed.ready).rejects.toThrow("Worker startup failed");
    expect(mock.pools[0].terminate).toHaveBeenCalledOnce();
    mock.initialize = () => Promise.resolve();
    const retry = acquireDiffRenderer();
    await retry.ready;
    failed.release();
    expect(mock.pools[1].terminate).not.toHaveBeenCalled();
    retry.release();
  });
});
