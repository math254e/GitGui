import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopUpdates, type UpdateEngine, type UpdateEngineEvents, type UpdateLifecycle } from "./desktop-updates.js";
import type { UpdateDiagnostic, UpdateDiagnosticSink } from "./update-diagnostics.js";

// Based on T3 DesktopUpdates.test.ts's bounded updater failure context test.
const secret = "https://user:secret@updates.test/private?token=secret C:\\private\\installer Authorization: Bearer secret";
const failure = Object.assign(new Error(secret, { cause: new Error(secret) }), {
  code: secret, path: secret, headers: { Authorization: secret }, _tag: secret,
});
const services: DesktopUpdates[] = [];

function harness(overrides: Partial<UpdateEngine> = {}, lifecycleOverrides: Partial<UpdateLifecycle> = {},
  diagnostics?: UpdateDiagnosticSink) {
  vi.useFakeTimers();
  const records: UpdateDiagnostic[] = [];
  let events!: UpdateEngineEvents;
  const engine: UpdateEngine = {
    configure: vi.fn(), subscribe: (callbacks) => { events = callbacks; return vi.fn(); },
    check: vi.fn(async () => events.available({ version: "1.2.0" })),
    download: vi.fn(async () => events.downloaded({ version: "1.2.0" })),
    install: vi.fn(), cancelDownload: vi.fn(), ...overrides,
  };
  const lifecycle: UpdateLifecycle = {
    stopForInstall: vi.fn(async () => {}), recoverFromInstall: vi.fn(async () => {}), ...lifecycleOverrides,
  };
  const updates = new DesktopUpdates(engine, lifecycle, { currentVersion: "1.1.0",
    releaseBaseUrl: "https://updates.test/releases", diagnostics: diagnostics ?? ((record) => records.push(record)) });
  services.push(updates);
  updates.start();
  return { updates, engine, lifecycle, records, get events() { return events; } };
}

function expectConfidential(h: ReturnType<typeof harness>) {
  const serialized = JSON.stringify({ records: h.records, status: h.updates.status });
  for (const value of ["secret", "Authorization", "private", "headers", "cause", "stack", "updates.test/private"]) {
    expect(serialized).not.toContain(value);
  }
  for (const record of h.records) {
    expect(record.component).toBe("desktop-updates");
    expect(record.channel).toBe("latest");
    expect(Object.keys(record).sort()).toEqual(record.event
      ? ["channel", "component", "errorTag", "event", "operation"]
      : ["channel", "component", "errorTag", "operation"]);
    expect(JSON.stringify(record).length).toBeLessThan(240);
    expect(Object.isFrozen(record)).toBe(true);
  }
}

afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("bounded updater diagnostics", () => {
  it.each(["configure", "subscribe"] as const)("reports %s failure and keeps configuration UI safe", (method) => {
    const h = harness({ [method]: () => { throw failure; } });
    expect(h.records).toEqual([{ component: "desktop-updates", channel: "latest",
      operation: "configure", errorTag: "DesktopUpdateConfigureError" }]);
    expect(h.updates.status).toMatchObject({ phase: "disabled",
      message: "The packaged update feed could not be configured." });
    expectConfidential(h);
  });

  it.each(["check", "download"] as const)("reports %s rejection and permits retry", async (operation) => {
    const h = harness();
    if (operation === "download") await h.updates.check();
    h.engine[operation] = async () => { throw failure; };
    await h.updates[operation]();
    expect(h.records).toEqual([{ component: "desktop-updates", channel: "latest", operation,
      errorTag: operation === "check" ? "ElectronUpdaterCheckForUpdatesError" : "ElectronUpdaterDownloadUpdateError" }]);
    expect(h.updates.status.errorContext).toBe(operation);
    expectConfidential(h);
    h.engine[operation] = async () => operation === "check"
      ? h.events.available({ version: "1.2.0" }) : h.events.downloaded({ version: "1.2.0" });
    await h.updates[operation]();
    expect(h.updates.status.phase).toBe(operation === "check" ? "available" : "downloaded");
  });

  it.each(["check", "download"] as const)("records %s error events and rejections independently", async (operation) => {
    const h = harness();
    if (operation === "download") await h.updates.check();
    h.engine[operation] = async () => { h.events.error(failure); throw failure; };
    await h.updates[operation]();
    expect(h.records.map(({ operation, errorTag }) => [operation, errorTag])).toEqual([
      [operation, "DesktopUpdaterReportedError"],
      [operation, operation === "check" ? "ElectronUpdaterCheckForUpdatesError" : "ElectronUpdaterDownloadUpdateError"],
    ]);
    expectConfidential(h);
  });

  it.each(["check", "download"] as const)("diagnoses %s finishing without its required event", async (operation) => {
    const h = harness();
    if (operation === "download") await h.updates.check();
    h.engine[operation] = async () => {};
    await h.updates[operation]();
    expect(h.records).toMatchObject([{ operation, errorTag: "DesktopUpdateIncompleteOperationError" }]);
    expectConfidential(h);
  });

  it.each(["preparation", "installer"] as const)("reports %s failures and retains the verified installer", async (stage) => {
    const h = harness();
    await h.updates.check(); await h.updates.download();
    if (stage === "preparation") h.lifecycle.stopForInstall = async () => { throw failure; };
    else h.engine.install = () => { throw failure; };
    await h.updates.install();
    expect(h.records).toMatchObject([{ operation: "install", errorTag: stage === "preparation"
      ? "DesktopUpdateInstallPreparationError" : "ElectronUpdaterQuitAndInstallError" }]);
    expect(h.updates.status).toMatchObject({ phase: "downloaded", downloadedVersion: "1.2.0", errorContext: "install" });
    expect(h.lifecycle.recoverFromInstall).toHaveBeenCalledOnce();
    expect(h.updates.isInstallActive).toBe(false);
    expectConfidential(h);
  });

  it("reports background, draining, installer and recovery events without changing reservation ownership", async () => {
    let finishPreparation!: () => void;
    let failRecovery!: (error: unknown) => void;
    const h = harness({}, {
      stopForInstall: () => new Promise<void>((resolve) => { finishPreparation = resolve; }),
      recoverFromInstall: () => new Promise<void>((_resolve, reject) => { failRecovery = reject; }),
    });
    await h.updates.check(); await h.updates.download();
    h.events.error(failure);
    expect(h.updates.status.phase).toBe("downloaded");
    const installing = h.updates.install();
    h.events.error(failure);
    expect(h.updates.isInstallActive).toBe(true);
    expect(h.records.at(-1)?.operation).toBe("install");
    finishPreparation(); await installing;
    h.events.error(failure); // asynchronous installer-spawn failure
    h.events.error(failure); // duplicate event during recovery
    expect(h.updates.isInstallActive).toBe(true);
    expect((await h.updates.install()).accepted).toBe(false);
    failRecovery(failure);
    await Promise.resolve(); await Promise.resolve();
    expect(h.updates.isInstallActive).toBe(false);
    expect(h.updates.status.message).toContain("Restart GitGui");
    expect(h.records.map(({ operation }) => operation)).toEqual(["background", "install", "install", "recovery", "recovery"]);
    expect(h.records.at(-1)?.errorTag).toBe("DesktopUpdateInstallRecoveryError");
    expectConfidential(h);
  });

  it("attributes an installer throw correctly when an error event already started recovery", async () => {
    const h = harness();
    await h.updates.check(); await h.updates.download();
    h.engine.install = () => { h.events.error(failure); throw failure; };
    await h.updates.install();
    expect(h.records.map(({ operation, errorTag }) => [operation, errorTag])).toEqual([
      ["install", "DesktopUpdaterReportedError"], ["install", "ElectronUpdaterQuitAndInstallError"],
    ]);
    expect(h.lifecycle.recoverFromInstall).toHaveBeenCalledOnce();
    expect(h.updates.isInstallActive).toBe(false);
    expect(h.updates.status).toMatchObject({ phase: "downloaded", errorContext: "install" });
    expectConfidential(h);
  });

  it("records malformed feed events with a bounded event name", async () => {
    const h = harness();
    h.engine.check = async () => h.events.available({ version: secret });
    await h.updates.check();
    h.engine.check = async () => h.events.available({ version: "1.2.0" });
    await h.updates.check();
    h.engine.download = async () => {
      h.events.progress(secret);
      h.events.downloaded({ version: secret });
    };
    await h.updates.download();
    expect(h.records.map(({ event }) => event)).toEqual(["update-available", "download-progress", "update-downloaded"]);
    expect(h.records.every(({ errorTag }) => errorTag === "DesktopUpdateEventHandlingError")).toBe(true);
    expectConfidential(h);
  });

  it("never reads error properties or nested causes, including hostile getters", async () => {
    const read = vi.fn(() => { throw new Error("Error metadata must never be inspected"); });
    const hostile = Object.defineProperties({}, Object.fromEntries(
      ["message", "stack", "cause", "code", "name", "headers", "_tag", "toString"].map((key) => [key, { get: read }]),
    ));
    const h = harness({ check: async () => { throw hostile; } });
    await h.updates.check();
    h.events.error(hostile);
    expect(read).not.toHaveBeenCalled();
    expect(h.records).toHaveLength(2);
    expectConfidential(h);
  });

  it("does not let a failing sink interrupt install recovery or subsequent retry", async () => {
    const h = harness({}, {}, () => { throw failure; });
    await h.updates.check(); await h.updates.download();
    h.engine.install = () => h.events.error(failure);
    await h.updates.install();
    expect(h.updates.isInstallActive).toBe(false);
    expect(h.lifecycle.recoverFromInstall).toHaveBeenCalledOnce();
    h.engine.install = vi.fn();
    expect((await h.updates.install()).accepted).toBe(true);
  });

  it("emits bounded diagnostics through the default desktop sink without configuration", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const engine = { configure() {}, subscribe: () => () => {}, check: async () => { throw failure; },
      download: async () => {}, install() {}, cancelDownload() {} };
    const updates = new DesktopUpdates(engine, { stopForInstall: async () => {}, recoverFromInstall: async () => {} },
      { currentVersion: "1.1.0", releaseBaseUrl: "https://updates.test" });
    services.push(updates);
    updates.start(); await updates.check();
    expect(log).toHaveBeenCalledExactlyOnceWith("[gitgui-updates]", {
      component: "desktop-updates", channel: "latest", operation: "check", errorTag: "ElectronUpdaterCheckForUpdatesError",
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
  });
});
