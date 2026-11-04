// Real Electron service/Effect manager through trusted IPC, with host/forward
// boundaries replaced. Carries the prior quit/update/prompt failure matrix.
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type { DesktopSshEnvironment } from "./ssh/DesktopSshEnvironment.js";
import type { SshEnvironmentManagerOptions } from "@gitgui/ssh";
import type { EnvironmentDescriptor, SshHostResponse } from "@gitgui/contracts";

const environmentId = "11111111-1111-4111-8111-111111111111";
const instanceId = "22222222-2222-4222-8222-222222222222";
const descriptor: EnvironmentDescriptor = { schemaVersion: 1, environmentId, label: "fixture", serverVersion: "0.1.0", protocolVersion: 2,
  platform: "linux", architecture: "x86_64", capabilities: [], auth: { required: true, bootstrapMethods: ["pairing"], sessionMethods: ["bearer"] }, endpoints: [] };
const fixture = vi.hoisted(() => ({
  hooks: undefined as unknown as { stopForInstall(): Promise<void>; recoverFromInstall(): Promise<void> },
  installActive: false, directory: "", service: undefined as DesktopSshEnvironment | undefined,
  shutdownForUpdate: vi.fn(async () => {}), recoverAfterUpdate: vi.fn(async () => {}), shutdown: vi.fn(async () => {}),
  closeSsh: vi.fn(async () => {}), reopenSsh: vi.fn(async () => {}), disposeUpdates: vi.fn(), quit: vi.fn(),
  primaryInstance: true, ready: vi.fn(async () => {}), loadWindow: vi.fn(async () => {}), showErrorBox: vi.fn(),
  handlers: new Map<string, (...args: any[]) => any>(), windows: [] as any[], showMessageBox: vi.fn(),
  dependencies: undefined as SshEnvironmentManagerOptions["dependencies"], pendingReadiness: false,
  manualStop: false, stopGate: undefined as unknown as Deferred.Deferred<void>,
  authKind: undefined as "password" | "trust" | undefined,
  authFailure: undefined as unknown as (kind: "password" | "trust") => any,
  launches: 0, tunnels: 0, live: new Set<number>(), stops: [] as number[], hostCalls: [] as string[],
}));

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class Window extends EventEmitter {
    constructor(..._args: unknown[]) { super(); fixture.windows.push(this); }
    destroyed = false;
    static getAllWindows() { return []; }
    webContents = Object.assign(new EventEmitter(), { id: fixture.windows.length + 1, mainFrame: { url: "gitgui://app/" }, send: vi.fn(), setWindowOpenHandler: vi.fn() });
    loadURL = fixture.loadWindow;
    show() {} focus() {}
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit("closed"); }
  }
  return {
    app: Object.assign(new EventEmitter(), { requestSingleInstanceLock: () => fixture.primaryInstance, quit: fixture.quit,
      whenReady: fixture.ready, getPath: () => fixture.directory, getVersion: () => "1.1.0", isPackaged: false }),
    autoUpdater: new EventEmitter(), BrowserWindow: Window, dialog: { showMessageBox: fixture.showMessageBox, showErrorBox: fixture.showErrorBox }, net: {},
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
    ipcMain: Object.assign(new EventEmitter(), { handle: (channel: string, handler: (...args: any[]) => any) => fixture.handlers.set(channel, handler) }),
  };
});
vi.mock("./ssh/DesktopSshEnvironment.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./ssh/DesktopSshEnvironment.js")>();
  // The mocked class factory survives resetModules; use errors from that same
  // production module graph so instanceof classification stays representative.
  const { SshFailure } = await import("@gitgui/ssh");
  const { SshCommandError } = await import("../../../packages/ssh/dist/errors.js");
  fixture.authFailure = kind => kind === "password" ? new SshFailure({ category: "authentication", message: "fixture rejected" }) : new SshCommandError({ category: "permission", reason: "unknown-host", message: "fixture unknown host", command: ["ssh"], exitCode: 255, stderr: "" });
  return { DesktopSshEnvironment: class extends actual.DesktopSshEnvironment {
    constructor(options: ConstructorParameters<typeof actual.DesktopSshEnvironment>[0]) { super({ ...options, dependencies: fixture.dependencies }); fixture.service = this; }
  } };
});
vi.mock("./backend-manager.js", () => ({ BackendManager: class {
  shutdownForUpdate = fixture.shutdownForUpdate; recoverAfterUpdate = fixture.recoverAfterUpdate; shutdown = fixture.shutdown;
} }));
vi.mock("./state-store.js", () => ({ DesktopStateStore: class {} }));
vi.mock("./updates/electron-updater.js", () => ({ packagedUpdateEngine: () => ({ engine: {}, hasFeed: true }), updateDisabledReason: () => "test" }));
vi.mock("./updates/desktop-updates.js", () => ({ DesktopUpdates: class {
  status = { phase: "downloaded", downloadedVersion: "1.2.0" };
  get isInstallActive() { return fixture.installActive; }
  constructor(_engine: unknown, hooks: typeof fixture.hooks) { fixture.hooks = hooks; }
  start() {} subscribe() { return () => {}; }
  dispose = fixture.disposeUpdates;
} }));

async function loadMain() {
  const { DesktopSshEnvironment } = await import("./ssh/DesktopSshEnvironment.js");
  fixture.closeSsh = vi.spyOn(DesktopSshEnvironment.prototype, "close");
  fixture.reopenSsh = vi.spyOn(DesktopSshEnvironment.prototype, "reopen");
  const electron = await import("electron");
  (electron.app as unknown as EventEmitter).removeAllListeners();
  (electron.autoUpdater as unknown as EventEmitter).removeAllListeners();
  await import("./main.js");
  await vi.waitFor(() => expect(fixture.handlers.has("desktop:ssh:ensure")).toBe(true));
  return electron;
}
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks();
  fixture.installActive = false; fixture.handlers.clear(); fixture.windows.length = 0;
  fixture.primaryInstance = true; fixture.ready.mockReset().mockResolvedValue(undefined);
  fixture.loadWindow.mockReset().mockResolvedValue(undefined); fixture.showErrorBox.mockReset();
  fixture.service = undefined; fixture.pendingReadiness = false; fixture.manualStop = false; fixture.authKind = undefined;
  fixture.launches = 0; fixture.tunnels = 0; fixture.live.clear(); fixture.stops = []; fixture.hostCalls = [];
  fixture.stopGate = Deferred.makeUnsafe();
  fixture.shutdownForUpdate.mockReset().mockResolvedValue(undefined); fixture.recoverAfterUpdate.mockReset().mockResolvedValue(undefined);
  fixture.directory = await mkdtemp(join(tmpdir(), "gitgui-main-ssh-"));
  fixture.dependencies = {
    resolve: target => Effect.succeed({ alias: target.host, hostname: target.host, username: "alice", port: 22 }),
    trust: (target, confirm) => confirm({ alias: target.alias, hostname: target.hostname, port: 22, fingerprints: ["ssh-ed25519 SHA256:fixture"] }).pipe(Effect.asVoid),
    host: (_target, operation, request) => Effect.suspend(() => {
      fixture.hostCalls.push(operation);
      if (operation === "ensure") {
        fixture.launches++;
        if (fixture.authKind) return Effect.fail(fixture.authFailure(fixture.authKind));
      }
      const result: SshHostResponse = { version: 1, acquisitionId: request.acquisitionId, outcome: operation === "cancel" ? "stopped" : operation === "release" ? "released" : "ready",
        instanceId, environmentId, remoteDataDirectory: "/state/fixture", port: 3774, ownership: "managed", expiresAtUnixMs: Date.now() + 300_000, pairing: null, message: null };
      return Effect.succeed(result);
    }),
    tunnel: () => Effect.gen(function* () {
      const id = yield* Effect.acquireRelease(Effect.sync(() => { const id = ++fixture.tunnels; fixture.live.add(id); return id; }), id => Effect.gen(function* () {
        fixture.stops.push(id); fixture.live.delete(id); if (fixture.manualStop) yield* Deferred.await(fixture.stopGate);
      }));
      if (fixture.pendingReadiness) yield* Effect.never;
      return { localPort: 40000 + id, descriptor, probe: Effect.succeed(descriptor) };
    }),
  };
});
afterEach(async () => {
  const electron = await import("electron");
  electron.app.emit("will-quit");
  Deferred.doneUnsafe(fixture.stopGate, Effect.void);
  await fixture.service?.dispose();
  await rm(fixture.directory, { recursive: true, force: true });
});
function event() { const sender = fixture.windows[0].webContents; return { sender, senderFrame: sender.mainFrame }; }
function ensureSsh(host = "fixture-host") {
  return fixture.handlers.get("desktop:ssh:ensure")!(event(), { kind: "ssh", host }, { operationId: randomUUID() });
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

describe("Electron startup failures", () => {
  it("cancels readiness as soon as the launcher requests quit, before native before-quit fires", async () => {
    const readiness = deferred(); fixture.ready.mockReturnValueOnce(readiness.promise);
    const previousSend = Object.getOwnPropertyDescriptor(process, "send");
    Object.defineProperty(process, "send", { configurable: true, value: vi.fn() });
    vi.stubEnv("GITGUI_DESKTOP_DEV_LAUNCHER", "1");
    const previousMessages = new Set(process.listeners("message"));
    try {
      const electron = await import("electron");
      electron.app.removeAllListeners(); electron.autoUpdater.removeAllListeners();
      await import("./main.js");
      // Do not dispatch fixture data through Vitest's own worker IPC listener.
      const launcherMessages = process.listeners("message").filter(listener => !previousMessages.has(listener));
      expect(launcherMessages).toHaveLength(1);
      launcherMessages[0]("gitgui:dev:quit");
      expect(fixture.quit).toHaveBeenCalledOnce();
      readiness.resolve(); await readiness.promise;
      expect(fixture.service).toBeUndefined(); expect(fixture.windows).toEqual([]);
    } finally {
      if (previousSend) Object.defineProperty(process, "send", previousSend);
      else delete process.send;
      vi.unstubAllEnvs();
    }
  });

  it("does not initialize services after quit while readiness was pending", async () => {
    const readiness = deferred(); fixture.ready.mockReturnValueOnce(readiness.promise);
    const electron = await import("electron");
    electron.app.removeAllListeners(); electron.autoUpdater.removeAllListeners();
    await import("./main.js");
    electron.app.emit("before-quit", { preventDefault: vi.fn() });
    await vi.waitFor(() => expect(fixture.quit).toHaveBeenCalledOnce());
    readiness.resolve(); await readiness.promise;
    expect(fixture.service).toBeUndefined(); expect(fixture.windows).toEqual([]); expect(fixture.handlers.size).toBe(0);
  });

  it("quits a secondary instance before readiness, IPC, services or windows initialize", async () => {
    fixture.primaryInstance = false;
    const electron = await import("electron");
    electron.app.removeAllListeners(); electron.autoUpdater.removeAllListeners();
    await import("./main.js");
    expect(fixture.quit).toHaveBeenCalledOnce();
    expect(fixture.ready).not.toHaveBeenCalled();
    expect(fixture.windows).toEqual([]); expect(fixture.handlers.size).toBe(0);
    expect(fixture.service).toBeUndefined();
    expect(electron.app.listenerCount("before-quit")).toBe(0);
  });

  it("handles a rejected window load and uses normal owned-resource shutdown", async () => {
    fixture.loadWindow.mockRejectedValueOnce(new Error("ERR_FAILED loading development frontend"));
    const electron = await loadMain();
    await vi.waitFor(() => expect(fixture.showErrorBox).toHaveBeenCalledOnce());
    expect(fixture.showErrorBox).toHaveBeenCalledWith("GitGui failed to start", expect.stringContaining("http://127.0.0.1:1420"));
    expect(fixture.quit).toHaveBeenCalledOnce();
    electron.app.emit("before-quit", { preventDefault: vi.fn() });
    await vi.waitFor(() => expect(fixture.shutdown).toHaveBeenCalledOnce());
    expect(fixture.closeSsh).toHaveBeenCalledOnce();
  });

  it("still quits if presenting the startup failure dialog throws", async () => {
    fixture.ready.mockRejectedValueOnce(new Error("Electron readiness failed"));
    fixture.showErrorBox.mockImplementationOnce(() => { throw new Error("dialog unavailable"); });
    const electron = await import("electron");
    electron.app.removeAllListeners(); electron.autoUpdater.removeAllListeners();
    await import("./main.js");
    await vi.waitFor(() => expect(fixture.quit).toHaveBeenCalledOnce());
    expect(fixture.windows).toEqual([]); expect(fixture.handlers.size).toBe(0);
  });

  it("handles a rejected window load after application activation", async () => {
    const electron = await loadMain();
    await vi.waitFor(() => expect(electron.app.listenerCount("activate")).toBe(1));
    fixture.loadWindow.mockRejectedValueOnce(new Error("activation load failed"));
    electron.app.emit("activate");
    await vi.waitFor(() => expect(fixture.showErrorBox).toHaveBeenCalledOnce());
    expect(fixture.quit).toHaveBeenCalledOnce();
  });
});

describe("Electron quit and updater handoff", () => {
  it("blocks quit during preparation and permits updater quit after exact backend/SSH stop", async () => {
    const electron = await loadMain(); fixture.installActive = true;
    const preparingQuit = { preventDefault: vi.fn() }; electron.app.emit("before-quit", preparingQuit);
    expect(preparingQuit.preventDefault).toHaveBeenCalledOnce(); expect(fixture.shutdown).not.toHaveBeenCalled();
    await fixture.hooks.stopForInstall();
    expect(fixture.shutdownForUpdate).toHaveBeenCalledOnce(); expect(fixture.closeSsh).toHaveBeenCalledOnce();
    electron.autoUpdater.emit("before-quit-for-update");
    const updateQuit = { preventDefault: vi.fn() }; electron.app.emit("before-quit", updateQuit);
    expect(updateQuit.preventDefault).not.toHaveBeenCalled(); electron.app.emit("will-quit"); expect(fixture.disposeUpdates).toHaveBeenCalledOnce();
  });
  it("suppresses an updater's already-scheduled quit after recovery", async () => {
    const electron = await loadMain(); fixture.installActive = true;
    await fixture.hooks.stopForInstall(); await fixture.hooks.recoverFromInstall(); fixture.installActive = false;
    expect(fixture.recoverAfterUpdate).toHaveBeenCalledOnce(); electron.autoUpdater.emit("before-quit-for-update");
    const staleQuit = { preventDefault: vi.fn() }; electron.app.emit("before-quit", staleQuit);
    expect(staleQuit.preventDefault).toHaveBeenCalledOnce(); expect(fixture.shutdown).not.toHaveBeenCalled(); expect(fixture.quit).not.toHaveBeenCalled();
  });
  it("keeps ordinary quit under the existing shutdown owner and disposes SSH", async () => {
    const electron = await loadMain(); const ordinaryQuit = { preventDefault: vi.fn() }; electron.app.emit("before-quit", ordinaryQuit);
    expect(ordinaryQuit.preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(fixture.quit).toHaveBeenCalledOnce());
    expect(fixture.shutdown).toHaveBeenCalledOnce(); expect(fixture.closeSsh).toHaveBeenCalledOnce();
  });
  it("closes SSH admission before backend preparation and drains late setup before updater quit", async () => {
    fixture.manualStop = true; fixture.pendingReadiness = true;
    const backendStopped = deferred(); fixture.shutdownForUpdate.mockReturnValueOnce(backendStopped.promise);
    const electron = await loadMain(); fixture.installActive = true;
    const setup = ensureSsh(); await vi.waitFor(() => expect(fixture.tunnels).toBe(1));
    let prepared = false; const stopping = fixture.hooks.stopForInstall().then(() => { prepared = true; });
    expect(await ensureSsh("reconnecting-host")).toMatchObject({ ok: false, error: { category: "cancelled" } });
    backendStopped.resolve(); await vi.waitFor(() => expect(fixture.stops).toEqual([1])); expect(prepared).toBe(false);
    const prematureQuit = { preventDefault: vi.fn() }; electron.app.emit("before-quit", prematureQuit); expect(prematureQuit.preventDefault).toHaveBeenCalledOnce();
    Deferred.doneUnsafe(fixture.stopGate, Effect.void); expect(await setup).toMatchObject({ ok: false, error: { category: "cancelled" } }); await stopping;
    expect(fixture.hostCalls).toEqual(["ensure", "cancel"]);
    const readyQuit = { preventDefault: vi.fn() }; electron.app.emit("before-quit", readyQuit); expect(readyQuit.preventDefault).not.toHaveBeenCalled();
  });
  it("keeps reconnect blocked through recovery and restores SSH only after the backend", async () => {
    const electron = await loadMain(); expect((await ensureSsh()).ok).toBe(true); fixture.installActive = true; await fixture.hooks.stopForInstall();
    const recovered = deferred(); fixture.recoverAfterUpdate.mockReturnValueOnce(recovered.promise); const recovery = fixture.hooks.recoverFromInstall();
    expect(await ensureSsh()).toMatchObject({ ok: false, error: { category: "cancelled" } }); expect(fixture.launches).toBe(1);
    recovered.resolve(); await recovery; fixture.installActive = false;
    expect((await ensureSsh()).value.descriptor.environmentId).toBe(environmentId); expect(fixture.launches).toBe(2); expect(fixture.stops).toEqual([1]);
    expect(fixture.reopenSsh).toHaveBeenCalledOnce(); electron.autoUpdater.emit("before-quit-for-update"); electron.app.emit("before-quit", { preventDefault: vi.fn() });
    expect(fixture.live.has(2)).toBe(true); electron.app.emit("before-quit", { preventDefault: vi.fn() });
    await vi.waitFor(() => expect(fixture.quit).toHaveBeenCalledOnce()); expect(fixture.live.size).toBe(0);
  });
  it("drains SSH after refused backend preparation and reopens after recovery", async () => {
    fixture.pendingReadiness = true; fixture.shutdownForUpdate.mockRejectedValueOnce(new Error("busy backend")); await loadMain();
    const setup = ensureSsh(); await vi.waitFor(() => expect(fixture.tunnels).toBe(1));
    await expect(fixture.hooks.stopForInstall()).rejects.toThrow("busy backend");
    expect(await setup).toMatchObject({ ok: false, error: { category: "cancelled" } }); expect(fixture.live.size).toBe(0); expect(fixture.hostCalls).toEqual(["ensure", "cancel"]);
    await fixture.hooks.recoverFromInstall(); fixture.pendingReadiness = false; expect((await ensureSsh()).ok).toBe(true);
    await fixture.handlers.get("desktop:ssh:disconnect")!(event(), { kind: "ssh", host: "fixture-host", remoteDataDirectory: "/state/fixture" }); expect(fixture.live.size).toBe(0);
  });
  it("keeps admission closed if backend recovery fails", async () => {
    const electron = await loadMain(); await ensureSsh(); fixture.installActive = true; await fixture.hooks.stopForInstall();
    fixture.recoverAfterUpdate.mockRejectedValueOnce(new Error("recovery failed")); await expect(fixture.hooks.recoverFromInstall()).rejects.toThrow("recovery failed");
    expect(await ensureSsh()).toMatchObject({ ok: false, error: { category: "cancelled" } }); expect(fixture.launches).toBe(1); expect(fixture.reopenSsh).not.toHaveBeenCalled();
    fixture.installActive = false; electron.app.emit("before-quit", { preventDefault: vi.fn() }); await vi.waitFor(() => expect(fixture.quit).toHaveBeenCalledOnce()); expect(fixture.stops).toEqual([1]);
  });
  it("drains pending setup and blocks reconnect during ordinary shutdown", async () => {
    fixture.manualStop = true; fixture.pendingReadiness = true; const electron = await loadMain();
    const setup = ensureSsh(); await vi.waitFor(() => expect(fixture.tunnels).toBe(1)); electron.app.emit("before-quit", { preventDefault: vi.fn() });
    expect(await ensureSsh()).toMatchObject({ ok: false, error: { category: "cancelled" } }); await vi.waitFor(() => expect(fixture.stops).toEqual([1])); expect(fixture.quit).not.toHaveBeenCalled();
    Deferred.doneUnsafe(fixture.stopGate, Effect.void); expect(await setup).toMatchObject({ ok: false, error: { category: "cancelled" } }); await vi.waitFor(() => expect(fixture.quit).toHaveBeenCalledOnce()); expect(fixture.launches).toBe(1);
  });
  it.each(["password", "trust"] as const)("cancels an unanswered %s prompt on ordinary quit", async kind => {
    fixture.authKind = kind; fixture.showMessageBox.mockImplementation((_window, options) => new Promise(resolve => { options.signal.addEventListener("abort", () => resolve({ response: 0 }), { once: true }); }));
    const electron = await loadMain(); const setup = ensureSsh();
    if (kind === "password") await vi.waitFor(() => expect(fixture.windows).toHaveLength(2)); else await vi.waitFor(() => expect(fixture.showMessageBox).toHaveBeenCalledOnce());
    electron.app.emit("before-quit", { preventDefault: vi.fn() }); expect(await setup).toMatchObject({ ok: false, error: { category: "cancelled" } });
    await vi.waitFor(() => expect(fixture.quit).toHaveBeenCalledOnce());
    if (kind === "password") { expect(fixture.windows[1].destroyed).toBe(true); expect(electron.ipcMain.listenerCount("desktop:secret-prompt:response")).toBe(0); }
    else expect(fixture.showMessageBox.mock.calls[0][1].signal.aborted).toBe(true);
    expect(fixture.launches).toBe(1);
  });
  it("rejects foreign sender, subframe and origin IPC before touching SSH", async () => {
    await loadMain(); const handler = fixture.handlers.get("desktop:ssh:ensure")!; const valid = event();
    for (const rejected of [{ ...valid, sender: {} }, { ...valid, senderFrame: { url: "gitgui://app/" } }]) expect(() => handler(rejected, { kind: "ssh", host: "fixture" }, { operationId: randomUUID() })).toThrow("untrusted renderer");
    valid.senderFrame.url = "https://untrusted.example/"; expect(() => handler(valid, { kind: "ssh", host: "fixture" }, { operationId: randomUUID() })).toThrow("untrusted renderer"); expect(fixture.hostCalls).toEqual([]);
  });
});
