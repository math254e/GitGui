import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  hooks: undefined as unknown as { stopForInstall(): Promise<void>; recoverFromInstall(): Promise<void> },
  installActive: false,
  shutdownForUpdate: vi.fn(async () => {}), recoverAfterUpdate: vi.fn(async () => {}),
  shutdown: vi.fn(async () => {}), closeSsh: vi.fn(async () => {}), dispose: vi.fn(), quit: vi.fn(),
}));

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class Window extends EventEmitter {
    static getAllWindows() { return []; }
    webContents = Object.assign(new EventEmitter(), { send: vi.fn(), setWindowOpenHandler: vi.fn() });
    loadURL = async () => {};
    show() {}
  }
  return {
    app: Object.assign(new EventEmitter(), { requestSingleInstanceLock: () => true, quit: fixture.quit,
      whenReady: async () => {}, getPath: () => "/fixture", getVersion: () => "1.1.0", isPackaged: false }),
    autoUpdater: new EventEmitter(), BrowserWindow: Window, dialog: {}, net: {},
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() }, ipcMain: { handle: vi.fn() },
  };
});
vi.mock("@gitgui/ssh", () => ({ SshEnvironmentManager: class { close = fixture.closeSsh; } }));
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
});

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
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(fixture.shutdown).toHaveBeenCalledOnce();
    expect(fixture.closeSsh).toHaveBeenCalledOnce();
    expect(fixture.quit).toHaveBeenCalledOnce();
  });
});
