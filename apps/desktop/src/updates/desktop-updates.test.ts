import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopUpdates, type UpdateEngine, type UpdateEngineEvents, type UpdateLifecycle } from "./desktop-updates.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(overrides: Partial<UpdateEngine> = {}, lifecycleOverrides: Partial<UpdateLifecycle> = {}, disabledReason?: string) {
  let events!: UpdateEngineEvents;
  const unsubscribe = vi.fn();
  const engine: UpdateEngine = {
    configure: vi.fn(), subscribe: (callbacks) => { events = callbacks; return unsubscribe; },
    check: vi.fn(async () => { events.available({ version: "1.2.0", releaseNotes: "<p>A useful fix</p>" }); }),
    download: vi.fn(async () => { events.progress(42.9); events.downloaded({ version: "1.2.0" }); }),
    install: vi.fn(), cancelDownload: vi.fn(), ...overrides,
  };
  const lifecycle: UpdateLifecycle = { stopForInstall: vi.fn(async () => {}), recoverFromInstall: vi.fn(async () => {}), ...lifecycleOverrides };
  const updates = new DesktopUpdates(engine, lifecycle, { currentVersion: "1.1.0", disabledReason,
    releaseBaseUrl: "https://github.com/math254e/GitGui/releases" });
  updates.start();
  return { updates, engine, lifecycle, unsubscribe, get events() { return events; } };
}

afterEach(() => vi.useRealTimers());

describe("desktop update lifecycle (adapted from T3 DesktopUpdates tests)", () => {
  it("checks automatically, without downloading, at startup and on the four-minute interval", async () => {
    vi.useFakeTimers();
    const h = harness();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(h.engine.check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.updates.status.phase).toBe("available");
    expect(h.engine.download).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(225_000);
    expect(h.engine.check).toHaveBeenCalledTimes(2);
    h.updates.dispose();
    await vi.advanceTimersByTimeAsync(480_000);
    expect(h.engine.check).toHaveBeenCalledTimes(2);
    expect(h.unsubscribe).toHaveBeenCalledOnce();
  });

  it("does not configure or check when disabled and rejects actions", async () => {
    const h = harness({}, {}, "Use the AppImage build.");
    expect(h.engine.configure).not.toHaveBeenCalled();
    expect(await h.updates.check()).toMatchObject({ phase: "disabled" });
    expect((await h.updates.download()).accepted).toBe(false);
    expect((await h.updates.install()).accepted).toBe(false);
    h.updates.dispose();
  });

  it("publishes decoded release notes as plain text through the update service", async () => {
    const h = harness();
    h.engine.check = async () => { h.events.available({ version: "1.2.0", releaseNotes: "<p>Fix &amp; polish &#128512; &lt;b&gt;literal&lt;/b&gt;</p>" }); };
    await h.updates.check();
    expect(h.updates.status.releaseNotes).toBe("Fix & polish \u{1f600} <b>literal</b>");
    h.updates.dispose();
  });

  it("retains a matching installer, then replaces it when a newer release is offered", async () => {
    const h = harness();
    const phases: string[] = [];
    const off = h.updates.subscribe((state) => phases.push(`${state.phase}:${state.downloadPercent}`));
    await h.updates.check();
    expect(h.updates.status.releaseNotes).toBe("A useful fix");
    expect(h.updates.status.releaseUrl).toBe("https://github.com/math254e/GitGui/releases/tag/v1.2.0");
    await h.updates.download();
    expect(phases).toContain("downloading:42");
    expect(h.updates.status).toMatchObject({ phase: "downloaded", downloadedVersion: "1.2.0", downloadPercent: 100 });
    h.engine.check = async () => { h.events.available({ version: "1.2.0" }); };
    await h.updates.check();
    expect(h.updates.status).toMatchObject({ phase: "downloaded", downloadedVersion: "1.2.0", availableVersion: "1.2.0" });
    expect(h.updates.status.releaseNotes).toBe("A useful fix");
    h.engine.check = async () => { h.events.available({ version: "1.2.0", releaseNotes: "Updated A notes" }); };
    await h.updates.check();
    expect(h.updates.status).toMatchObject({ phase: "downloaded", downloadedVersion: "1.2.0", releaseNotes: "Updated A notes" });
    h.engine.check = async () => { throw new Error("https://user:private@feed.test?token=private"); };
    await h.updates.check();
    expect(h.updates.status).toMatchObject({ phase: "downloaded", downloadedVersion: "1.2.0" });
    expect(JSON.stringify(h.updates.status)).not.toContain("private");
    h.engine.check = async () => { h.events.available({ version: "1.3.0", releaseNotes: "B release" }); };
    await h.updates.check();
    expect(h.updates.status).toMatchObject({ phase: "available", availableVersion: "1.3.0", releaseNotes: "B release" });
    expect(h.updates.status.downloadedVersion).toBeUndefined();
    expect(h.updates.status.downloadPercent).toBeUndefined();
    expect((await h.updates.install("1.2.0")).accepted).toBe(false);

    h.engine.download = async () => { h.events.downloaded({ version: "1.3.0" }); };
    expect((await h.updates.download()).status).toMatchObject({ phase: "downloaded", downloadedVersion: "1.3.0" });
    expect((await h.updates.install("1.2.0")).accepted).toBe(false);
    expect((await h.updates.install("1.3.0")).accepted).toBe(true);
    expect(h.engine.install).toHaveBeenCalledOnce();
    off(); h.updates.dispose();
  });

  it("clears an obsolete offer when the feed reports no update and keeps check errors safe", async () => {
    const h = harness();
    await h.updates.check();
    await h.updates.download();
    h.engine.check = async () => { h.events.current(); };
    await h.updates.check();
    expect(h.updates.status).toMatchObject({ phase: "downloaded", downloadedVersion: "1.2.0" });

    h.engine.check = async () => { h.events.available({ version: "1.3.0" }); };
    await h.updates.check();
    h.engine.check = async () => { throw new Error("private feed details"); };
    await h.updates.check();
    expect(h.updates.status).toMatchObject({ phase: "error", errorContext: "check", availableVersion: "1.3.0" });
    expect(h.updates.status.downloadedVersion).toBeUndefined();
    expect(JSON.stringify(h.updates.status)).not.toContain("private");
    h.engine.check = async () => { h.events.current(); };
    await h.updates.check();
    expect(h.updates.status).toMatchObject({ phase: "current" });
    expect(h.updates.status.availableVersion).toBeUndefined();
    expect(h.updates.status.releaseNotes).toBeUndefined();
    h.updates.dispose();
  });

  it("serializes downloads and checks, rejects stale installs, and holds the install reservation", async () => {
    const download = deferred();
    const h = harness({ download: () => download.promise });
    await h.updates.check();
    const pending = h.updates.download();
    expect((await h.updates.download()).accepted).toBe(false);
    await h.updates.check();
    expect(h.engine.check).toHaveBeenCalledOnce();
    h.events.downloaded({ version: "1.2.0" }); download.resolve(); await pending;
    expect((await h.updates.install("1.3.0")).accepted).toBe(false);
    expect((await h.updates.install("1.2.0")).accepted).toBe(true);
    expect(h.lifecycle.stopForInstall).toHaveBeenCalledOnce();
    expect(h.engine.install).toHaveBeenCalledOnce();
    expect((await h.updates.install()).accepted).toBe(false);
    await h.updates.check();
    expect(h.engine.check).toHaveBeenCalledOnce();
    h.updates.dispose();
  });

  it.each(["matching", "replacement", "failed"])("revalidates a confirmed install after a %s background check", async (outcome) => {
    const h = harness();
    await h.updates.check(); await h.updates.download();
    const checked = deferred();
    h.engine.check = async () => {
      await checked.promise;
      if (outcome === "failed") throw new Error("feed unavailable");
      h.events.available({ version: outcome === "matching" ? "1.2.0" : "1.3.0" });
    };
    const checking = h.updates.check();
    let finished = false;
    const installing = h.updates.install("1.2.0").then((result) => { finished = true; return result; });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(h.lifecycle.stopForInstall).not.toHaveBeenCalled();
    checked.resolve(); await checking;
    expect((await installing).accepted).toBe(outcome !== "replacement");
    expect(h.engine.install).toHaveBeenCalledTimes(outcome === "replacement" ? 0 : 1);
    if (outcome === "replacement") expect(h.updates.status.availableVersion).toBe("1.3.0");
    h.updates.dispose();
  });

  it("bounds the wait for a check at 90 seconds and permits a later retry", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.updates.check(); await h.updates.download();
    const checked = deferred();
    h.engine.check = async () => { await checked.promise; h.events.available({ version: "1.2.0" }); };
    const checking = h.updates.check();
    let finished = false;
    const installing = h.updates.install("1.2.0").then((result) => { finished = true; return result; });
    await vi.advanceTimersByTimeAsync(89_999);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await installing).accepted).toBe(false);
    expect(h.engine.install).not.toHaveBeenCalled();
    checked.resolve(); await checking;
    expect((await h.updates.install("1.2.0")).accepted).toBe(true);
    h.updates.dispose();
  });

  it("releases waiting confirmations on disposal without installing", async () => {
    const h = harness();
    await h.updates.check(); await h.updates.download();
    const checked = deferred();
    h.engine.check = () => checked.promise;
    const checking = h.updates.check();
    const installing = h.updates.install("1.2.0");
    h.updates.dispose();
    expect((await installing).accepted).toBe(false);
    expect(h.engine.install).not.toHaveBeenCalled();
    checked.resolve(); await checking;
  });

  it("admits only one of two confirmations waiting for the same check", async () => {
    const h = harness();
    await h.updates.check(); await h.updates.download();
    const checked = deferred();
    h.engine.check = async () => { await checked.promise; h.events.available({ version: "1.2.0" }); };
    const checking = h.updates.check();
    expect((await h.updates.install()).accepted).toBe(false);
    const first = h.updates.install("1.2.0");
    const second = h.updates.install("1.2.0");
    checked.resolve(); await checking;
    expect((await first).accepted).toBe(true);
    expect((await second).accepted).toBe(false);
    expect(h.engine.install).toHaveBeenCalledOnce();
    h.updates.dispose();
  });

  it("does not install when local Git work cannot drain, and recovers before releasing the action", async () => {
    const recovery = deferred();
    const h = harness({}, { stopForInstall: async () => { throw new Error("busy"); }, recoverFromInstall: () => recovery.promise });
    await h.updates.check(); await h.updates.download();
    const installing = h.updates.install();
    await Promise.resolve(); await Promise.resolve();
    expect(h.updates.isInstallActive).toBe(true);
    expect((await h.updates.install()).accepted).toBe(false);
    expect(h.engine.install).not.toHaveBeenCalled();
    recovery.resolve(); await installing;
    expect(h.updates.status).toMatchObject({ phase: "downloaded", errorContext: "install", downloadedVersion: "1.2.0" });
    expect(h.updates.isInstallActive).toBe(false);
    h.updates.dispose();
  });

  it("ignores unrelated updater errors while Git work is still draining", async () => {
    const preparation = deferred();
    const h = harness({}, { stopForInstall: () => preparation.promise });
    await h.updates.check(); await h.updates.download();
    const installing = h.updates.install();
    h.events.error(new Error("late check error"));
    expect(h.lifecycle.recoverFromInstall).not.toHaveBeenCalled();
    preparation.resolve(); await installing;
    expect(h.engine.install).toHaveBeenCalledOnce();
    h.updates.dispose();
  });

  it.each(["throw", "event"])("restores the server and permits retry after a %s install failure", async (mode) => {
    const h = harness();
    h.engine.install = () => {
      if (mode === "throw") throw new Error("private install details");
      h.events.error(new Error("private event details"));
    };
    await h.updates.check(); await h.updates.download();
    await h.updates.install();
    expect(h.lifecycle.recoverFromInstall).toHaveBeenCalledOnce();
    expect(h.updates.status).toMatchObject({ phase: "downloaded", errorContext: "install" });
    expect(JSON.stringify(h.updates.status)).not.toContain("private");
    h.engine.install = vi.fn();
    expect((await h.updates.install()).accepted).toBe(true);
    h.updates.dispose();
  });

  it("handles an asynchronous installer error once while retaining its reservation through recovery", async () => {
    const recovery = deferred();
    const h = harness({}, { recoverFromInstall: () => recovery.promise });
    await h.updates.check(); await h.updates.download(); await h.updates.install();
    h.events.error(new Error("failed")); h.events.error(new Error("duplicate"));
    expect(h.updates.isInstallActive).toBe(true);
    expect((await h.updates.install()).accepted).toBe(false);
    recovery.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(h.updates.isInstallActive).toBe(false);
    expect(h.updates.status.errorContext).toBe("install");
    h.updates.dispose();
  });

  it("rejects malformed or mismatched download events and supports retry after failure", async () => {
    const h = harness();
    await h.updates.check();
    h.engine.download = async () => { h.events.downloaded({ version: "9.9.9" }); };
    await h.updates.download();
    expect(h.updates.status).toMatchObject({ phase: "available", errorContext: "download" });
    expect(h.updates.status.downloadedVersion).toBeUndefined();
    h.engine.download = async () => { h.events.downloaded({ version: "1.2.0" }); };
    await h.updates.download();
    expect(h.updates.status.phase).toBe("downloaded");
    h.updates.dispose();
  });
});
