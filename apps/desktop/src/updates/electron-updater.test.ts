import { afterEach, describe, expect, it, vi } from "vitest";

const { updater } = vi.hoisted(() => ({ updater: {
  logger: undefined as unknown, autoDownload: true, autoInstallOnAppQuit: true,
  allowPrerelease: true, channel: "nightly", allowDowngrade: true, disableWebInstaller: false,
  quitAndInstallCalled: true,
  setFeedURL: vi.fn(), checkForUpdates: vi.fn(async () => null), downloadUpdate: vi.fn(async () => []),
  quitAndInstall: vi.fn(), on: vi.fn(), removeListener: vi.fn(),
} }));
vi.mock("electron-updater", () => ({ default: { autoUpdater: updater, CancellationToken: class { cancel() {} } } }));
vi.mock("node:fs", () => ({ existsSync: () => true }));
import { packagedUpdateEngine, updateDisabledReason } from "./electron-updater.js";

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("packaged updater policy", () => {
  it("uses the baked feed and explicitly disables automatic download and quit installation", () => {
    vi.stubEnv("GITGUI_UPDATE_FEED_URL", "");
    const { engine, hasFeed } = packagedUpdateEngine("/fixture");
    expect(hasFeed).toBe(true);
    engine.configure();
    expect(updater).toMatchObject({ logger: null, autoDownload: false, autoInstallOnAppQuit: false,
      allowPrerelease: false, channel: "latest", allowDowngrade: false, disableWebInstaller: true });
    expect(updater.setFeedURL).not.toHaveBeenCalled();
    engine.install();
    expect(updater.quitAndInstallCalled).toBe(false);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it("accepts only safe override feeds and never forwards credentials to updater", () => {
    vi.stubEnv("GITGUI_UPDATE_FEED_URL", "https://updates.example.test/gitgui/");
    packagedUpdateEngine("/fixture").engine.configure();
    expect(updater.setFeedURL).toHaveBeenCalledWith({ provider: "generic", url: "https://updates.example.test/gitgui" });
    updater.setFeedURL.mockClear();
    vi.stubEnv("GITGUI_UPDATE_FEED_URL", "https://updates.example.test?token=private");
    expect(() => packagedUpdateEngine("/fixture").engine.configure()).toThrow("Invalid update feed");
    expect(updater.setFeedURL).not.toHaveBeenCalled();
  });

  it("enables packaged Windows and AppImage Linux only", () => {
    expect(updateDisabledReason(true, "win32", undefined, true, false)).toBeUndefined();
    expect(updateDisabledReason(true, "linux", "/app/GitGui.AppImage", true, false)).toBeUndefined();
    expect(updateDisabledReason(true, "linux", undefined, true, false)).toContain("AppImage");
    expect(updateDisabledReason(false, "win32", undefined, true, false)).toContain("packaged");
    expect(updateDisabledReason(true, "darwin", undefined, true, false)).toContain("Windows and Linux");
    expect(updateDisabledReason(true, "win32", undefined, false, false)).toContain("feed");
    expect(updateDisabledReason(true, "win32", undefined, true, true)).toContain("disabled");
  });
});
