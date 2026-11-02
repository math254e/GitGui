import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred, sshProcessFixture } from "../../../packages/ssh/testing/ssh-fixture.js";

const fixture = vi.hoisted(() => ({
  hooks: undefined as unknown as { stopForInstall(): Promise<void>; recoverFromInstall(): Promise<void> },
  installActive: false,
  shutdownForUpdate: vi.fn(async () => {}), recoverAfterUpdate: vi.fn(async () => {}),
  shutdown: vi.fn(async () => {}), closeSsh: vi.fn(async () => {}), dispose: vi.fn(), quit: vi.fn(),
  reopenSsh: vi.fn(async () => {}), spawn: vi.fn(),
  handlers: new Map<string, (...args: any[]) => any>(),
}));

vi.mock("node:child_process", () => ({ spawn: fixture.spawn }));

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class Window extends EventEmitter {
    static getAllWindows() { return []; }
    webContents = Object.assign(new EventEmitter(), { send: vi.fn(), setWindowOpenHandler: vi.fn() });
    loadURL = async () => {};
    show() {}
    isDestroyed() { return false; }
  }
  return {
    app: Object.assign(new EventEmitter(), { requestSingleInstanceLock: () => true, quit: fixture.quit,
      whenReady: async () => {}, getPath: () => "/fixture", getVersion: () => "1.1.0", isPackaged: false }),
    autoUpdater: new EventEmitter(), BrowserWindow: Window, dialog: {}, net: {},
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
    ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => fixture.handlers.set(channel, handler) },
  };
});
// Use the real SSH manager through IPC, with controlled process/HTTP boundaries.
vi.mock("@gitgui/ssh", () => import("../../../packages/ssh/src/index.js"));
vi.mock("./backend-manager.js", () => ({ BackendManager: class {
  shutdownForUpdate = fixture.shutdownForUpdate; recoverAfterUpdate = fixture.recoverAfterUpdate; shutdown = fixture.shutdown;
} }));
vi.mock("./state-store.js", () => ({ DesktopStateStore: class {} }));
vi.mock("./updates/electron-updater.js", () => ({ packagedUpdateEngine: () => ({ engine: {}, hasFeed: true }),
  updateDisabledReason: () => "test" }));
vi.mock("./updates/desktop-updates.js", () => ({ DesktopUpdates: class {
  status = { phase: "downloaded", downloadedVersion: "1.2.0" };
  get isInstallActive() { return fixture.installActive; }
  constructor(_engine: unknown, hooks: typeof fixture.hooks) { fixture.hooks = hooks; }
  start() {}
  subscribe() { return () => {}; }
  dispose = fixture.dispose;
} }));

async function loadMain() {
  const { SshEnvironmentManager } = await import("@gitgui/ssh");
  fixture.closeSsh = vi.spyOn(SshEnvironmentManager.prototype, "close");
  fixture.reopenSsh = vi.spyOn(SshEnvironmentManager.prototype, "reopen");
  const electron = await import("electron");
  (electron.app as unknown as EventEmitter).removeAllListeners();
  (electron.autoUpdater as unknown as EventEmitter).removeAllListeners();
  await import("./main.js");
  await Promise.resolve(); await Promise.resolve();
  return electron;
}

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  fixture.installActive = false;
  fixture.handlers.clear();
  fixture.shutdownForUpdate.mockReset().mockResolvedValue(undefined);
  fixture.recoverAfterUpdate.mockReset().mockResolvedValue(undefined);
  fixture.spawn.mockImplementation(sshProcessFixture().spawn);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ environmentId: "same-environment" })));
});
afterEach(() => vi.unstubAllGlobals());

function ensureSsh(host = "fixture-host") {
  return fixture.handlers.get("desktop:ssh:ensure")!({ senderFrame: { url: "gitgui://app/" } }, { host });
}

describe("Electron quit and updater handoff", () => {
  it("blocks quit while preparing, then permits updater quit after the exact backend stop", async () => {
    const electron = await loadMain();
    fixture.installActive = true;
    const preparingQuit = { preventDefault: vi.fn() };
    electron.app.emit("before-quit", preparingQuit);
    expect(preparingQuit.preventDefault).toHaveBeenCalledOnce();
    expect(fixture.shutdown).not.toHaveBeenCalled();
    await fixture.hooks.stopForInstall();
    expect(fixture.shutdownForUpdate).toHaveBeenCalledOnce();
    expect(fixture.closeSsh).toHaveBeenCalledOnce();
    electron.autoUpdater.emit("before-quit-for-update");
    const updateQuit = { preventDefault: vi.fn() };
    electron.app.emit("before-quit", updateQuit);
    expect(updateQuit.preventDefault).not.toHaveBeenCalled();
    electron.app.emit("will-quit");
    expect(fixture.dispose).toHaveBeenCalledOnce();
  });

  it("suppresses the updater's already-scheduled quit after installation recovery", async () => {
    const electron = await loadMain();
    fixture.installActive = true;
    await fixture.hooks.stopForInstall();
    await fixture.hooks.recoverFromInstall();
    fixture.installActive = false;
    expect(fixture.recoverAfterUpdate).toHaveBeenCalledOnce();
    electron.autoUpdater.emit("before-quit-for-update");
    const staleQuit = { preventDefault: vi.fn() };
    electron.app.emit("before-quit", staleQuit);
    expect(staleQuit.preventDefault).toHaveBeenCalledOnce();
    expect(fixture.shutdown).not.toHaveBeenCalled();
    expect(fixture.quit).not.toHaveBeenCalled();
  });

  it("keeps ordinary app quit under the existing shutdown owner", async () => {
    const electron = await loadMain();
    const ordinaryQuit = { preventDefault: vi.fn() };
    electron.app.emit("before-quit", ordinaryQuit);
    expect(ordinaryQuit.preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(fixture.quit).toHaveBeenCalledOnce());
    expect(fixture.shutdown).toHaveBeenCalledOnce();
    expect(fixture.closeSsh).toHaveBeenCalledOnce();
    expect(fixture.quit).toHaveBeenCalledOnce();
  });

  it("closes SSH admission before backend preparation and drains late setup before updater quit", async () => {
    const process = sshProcessFixture({ manualLaunch: true, manualStop: true });
    fixture.spawn.mockImplementation(process.spawn);
    const backendStopped = deferred();
    fixture.shutdownForUpdate.mockReturnValueOnce(backendStopped.promise);
    const electron = await loadMain();
    fixture.installActive = true;
    const setup = expect(ensureSsh()).rejects.toThrow("SSH connections are closed");
    let prepared = false;
    const stopping = fixture.hooks.stopForInstall().then(() => { prepared = true; });
    await expect(ensureSsh("reconnecting-host")).rejects.toThrow("SSH connections are closed");
    backendStopped.resolve();
    process.launchResult();
    await vi.waitFor(() => expect(process.stops).toHaveLength(1));
    expect(prepared).toBe(false);
    const prematureQuit = { preventDefault: vi.fn() };
    electron.app.emit("before-quit", prematureQuit);
    expect(prematureQuit.preventDefault).toHaveBeenCalledOnce();
    process.finishStop();
    await setup;
    await stopping;
    expect(process.tunnels[0].kill).toHaveBeenCalledOnce();
    const readyQuit = { preventDefault: vi.fn() };
    electron.app.emit("before-quit", readyQuit);
    expect(readyQuit.preventDefault).not.toHaveBeenCalled();
    expect(process.launches).toHaveLength(1);
  });

  it("keeps reconnect blocked through failed-install recovery, then restores SSH", async () => {
    const process = sshProcessFixture({ reused: true });
    fixture.spawn.mockImplementation(process.spawn);
    const electron = await loadMain();
    await ensureSsh();
    fixture.installActive = true;
    await fixture.hooks.stopForInstall();
    const backendRecovered = deferred();
    fixture.recoverAfterUpdate.mockReturnValueOnce(backendRecovered.promise);
    const recovery = fixture.hooks.recoverFromInstall();
    await expect(ensureSsh()).rejects.toThrow("SSH connections are closed");
    expect(process.launches).toHaveLength(1);
    backendRecovered.resolve();
    await recovery;
    fixture.installActive = false;
    expect((await ensureSsh()).descriptor.environmentId).toBe("same-environment");
    expect(process.launches).toHaveLength(2);
    expect(process.stops).toHaveLength(1);
    expect(fixture.reopenSsh).toHaveBeenCalledOnce();
    electron.autoUpdater.emit("before-quit-for-update");
    electron.app.emit("before-quit", { preventDefault: vi.fn() });
    expect(process.tunnels[1].killed).toBe(false);
    electron.app.emit("before-quit", { preventDefault: vi.fn() });
    await vi.waitFor(() => expect(fixture.quit).toHaveBeenCalledOnce());
    expect(process.tunnels[1].killed).toBe(true);
  });

  it("drains SSH even when backend preparation fails and reopens after recovery", async () => {
    const process = sshProcessFixture({ manualLaunch: true });
    fixture.spawn.mockImplementation(process.spawn);
    fixture.shutdownForUpdate.mockRejectedValueOnce(new Error("busy backend"));
    await loadMain();
    const setup = expect(ensureSsh()).rejects.toThrow("SSH connections are closed");
    const stopping = expect(fixture.hooks.stopForInstall()).rejects.toThrow("busy backend");
    process.launchResult();
    await setup;
    await stopping;
    expect(process.tunnels[0].killed).toBe(true);
    expect(process.stops).toHaveLength(1);
    await fixture.hooks.recoverFromInstall();
    fixture.spawn.mockImplementation(sshProcessFixture().spawn);
    await ensureSsh();
    await fixture.handlers.get("desktop:ssh:disconnect")!({ senderFrame: { url: "gitgui://app/" } }, { host: "fixture-host" });
  });

  it("keeps SSH admission closed when local backend recovery fails", async () => {
    const process = sshProcessFixture();
    fixture.spawn.mockImplementation(process.spawn);
    const electron = await loadMain();
    await ensureSsh();
    fixture.installActive = true;
    await fixture.hooks.stopForInstall();
    fixture.recoverAfterUpdate.mockRejectedValueOnce(new Error("recovery failed"));
    await expect(fixture.hooks.recoverFromInstall()).rejects.toThrow("recovery failed");
    await expect(ensureSsh()).rejects.toThrow("SSH connections are closed");
    expect(process.launches).toHaveLength(1);
    expect(fixture.reopenSsh).not.toHaveBeenCalled();
    fixture.installActive = false;
    electron.app.emit("before-quit", { preventDefault: vi.fn() });
    await vi.waitFor(() => expect(fixture.quit).toHaveBeenCalledOnce());
    expect(process.stops).toHaveLength(1);
  });

  it("drains pending setup and blocks reconnect during ordinary app shutdown", async () => {
    const process = sshProcessFixture({ manualLaunch: true, manualStop: true });
    fixture.spawn.mockImplementation(process.spawn);
    const electron = await loadMain();
    const setup = expect(ensureSsh()).rejects.toThrow("SSH connections are closed");
    electron.app.emit("before-quit", { preventDefault: vi.fn() });
    await expect(ensureSsh()).rejects.toThrow("SSH connections are closed");
    process.launchResult();
    await vi.waitFor(() => expect(process.stops).toHaveLength(1));
    expect(fixture.quit).not.toHaveBeenCalled();
    process.finishStop();
    await setup;
    await vi.waitFor(() => expect(fixture.quit).toHaveBeenCalledOnce());
    expect(process.tunnels[0].kill).toHaveBeenCalledOnce();
    expect(process.launches).toHaveLength(1);
  });
});
