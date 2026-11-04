import { describe, expect, it, vi } from "vitest";
import type { DesktopBridge, DesktopUpdateStatus } from "@gitgui/contracts/desktop";
import { createDesktopUpdateController, getDesktopReleaseUrl, getReleaseNotesPreview, shouldShowDesktopUpdateControl } from "./controller";

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

function fakeBridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    getPrimaryEnvironment: async () => { throw new Error("unused"); },
    restartPrimaryEnvironment: async () => { throw new Error("unused"); },
    listConnectionRegistrations: async () => [],
    saveConnectionRegistration: async () => {},
    removeConnectionRegistration: async () => {},
    getCredential: async () => undefined,
    setCredential: async () => {},
    removeCredential: async () => {},
    pickFolder: async () => null,
    discoverSshHosts: async () => [],
    ensureSshConnection: async () => { throw new Error("unused"); },
    disconnectSshConnection: async () => [],
    getUpdateStatus: async () => ({ phase: "idle" }),
    checkForUpdates: async () => ({ phase: "current" }),
    downloadUpdate: async () => ({ accepted: true, status: { phase: "downloading" } }),
    installUpdate: async () => ({ accepted: true, status: { phase: "installing" } }),
    onUpdateStatus: () => () => {},
    onDeepLink: () => () => {},
    onApplicationWakeup: () => () => {},
    ...overrides,
  } as DesktopBridge;
}

describe("desktop update controller", () => {
  it("subscribes before the initial read and keeps a newer event", async () => {
    const initial = deferred<DesktopUpdateStatus>();
    let emit!: (status: DesktopUpdateStatus) => void;
    const bridge = fakeBridge({
      getUpdateStatus: () => initial.promise,
      onUpdateStatus(listener) {
        emit = listener;
        return () => {};
      },
    });
    const controller = createDesktopUpdateController(bridge);
    controller.start();
    emit({ phase: "available", availableVersion: "2.0.0" });
    initial.resolve({ phase: "idle", currentVersion: "1.0.0" });
    await initial.promise;
    await Promise.resolve();
    expect(controller.getSnapshot().status).toMatchObject({ phase: "available", availableVersion: "2.0.0" });
  });

  it("unsubscribes on stop and ignores an initial read that finishes after disposal", async () => {
    const initial = deferred<DesktopUpdateStatus>();
    const unsubscribe = vi.fn();
    const bridge = fakeBridge({ getUpdateStatus: () => initial.promise, onUpdateStatus: () => unsubscribe });
    const controller = createDesktopUpdateController(bridge);
    controller.start();
    controller.stop();
    initial.resolve({ phase: "current", currentVersion: "1.0.0" });
    await Promise.resolve();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().status.phase).toBe("disabled");
  });

  it("passes the downloaded version to install and exposes pending state", async () => {
    const install = vi.fn(async (expectedVersion?: string) => ({
      accepted: true,
      status: { phase: "installing" as const, currentVersion: expectedVersion },
    }));
    const bridge = fakeBridge({
      getUpdateStatus: async () => ({ phase: "downloaded", downloadedVersion: "2.1.0" }),
      installUpdate: install,
    });
    const controller = createDesktopUpdateController(bridge);
    controller.start();
    await Promise.resolve();
    const pending = deferred<Awaited<ReturnType<typeof install>>>();
    install.mockReturnValueOnce(pending.promise);
    const operation = controller.install();
    expect(controller.getSnapshot().pendingAction).toBe("install");
    pending.resolve({ accepted: true, status: { phase: "installing", currentVersion: "2.1.0" } });
    await operation;
    expect(install).toHaveBeenCalledWith("2.1.0");
    expect(controller.getSnapshot().status.phase).toBe("installing");
    expect(controller.getSnapshot().pendingAction).toBeNull();
  });

  it("keeps the downloaded installer available when an install request fails", async () => {
    const bridge = fakeBridge({
      getUpdateStatus: async () => ({ phase: "downloaded", downloadedVersion: "2.1.0" }),
      installUpdate: async () => { throw new Error("Restart could not be scheduled"); },
    });
    const controller = createDesktopUpdateController(bridge);
    controller.start();
    await Promise.resolve();
    await controller.install();
    expect(controller.getSnapshot().status).toMatchObject({
      phase: "error",
      errorContext: "install",
      downloadedVersion: "2.1.0",
      message: "Restart could not be scheduled",
    });
  });

  it("passes the version the user confirmed even if a newer status arrives", async () => {
    let emit!: (status: DesktopUpdateStatus) => void;
    const install = vi.fn(async () => ({ accepted: false, status: { phase: "downloaded" as const, downloadedVersion: "2.2.0" } }));
    const controller = createDesktopUpdateController(fakeBridge({
      getUpdateStatus: async () => ({ phase: "downloaded", downloadedVersion: "2.1.0" }),
      onUpdateStatus: (listener) => { emit = listener; return () => {}; },
      installUpdate: install,
    }));
    controller.start(); await Promise.resolve();
    emit({ phase: "downloaded", downloadedVersion: "2.2.0" });
    await controller.install("2.1.0");
    expect(install).toHaveBeenCalledWith("2.1.0");
    controller.stop(); await controller.install();
    expect(install).toHaveBeenCalledOnce();
  });
});

describe("desktop release content", () => {
  it("hides idle states while preserving actionable, failed, and in-progress updates", () => {
    expect(shouldShowDesktopUpdateControl({ phase: "disabled", message: "development build" })).toBe(false);
    expect(shouldShowDesktopUpdateControl({ phase: "idle" })).toBe(false);
    expect(shouldShowDesktopUpdateControl({ phase: "current" })).toBe(false);
    expect(shouldShowDesktopUpdateControl({ phase: "checking" })).toBe(false);
    expect(shouldShowDesktopUpdateControl({ phase: "checking", downloadedVersion: "1.2.0" })).toBe(true);
    expect(shouldShowDesktopUpdateControl({ phase: "available", availableVersion: "1.2.0", message: "Retry download" })).toBe(true);
    expect(shouldShowDesktopUpdateControl({ phase: "installing" })).toBe(true);
    expect(shouldShowDesktopUpdateControl({ phase: "error" })).toBe(true);
  });

  it("allows only HTTPS GitHub release links", () => {
    expect(getDesktopReleaseUrl({ phase: "available", releaseUrl: "https://github.com/example/gitgui/releases/tag/v2" })).toBe("https://github.com/example/gitgui/releases/tag/v2");
    expect(getDesktopReleaseUrl({ phase: "available", releaseUrl: "http://github.com/example/gitgui/releases" })).toBeNull();
    expect(getDesktopReleaseUrl({ phase: "available", releaseUrl: "https://github.com.evil.test/example/gitgui/releases" })).toBeNull();
  });

  it("returns a bounded text preview", () => {
    expect(getReleaseNotesPreview("  plain text notes  ")).toBe("plain text notes");
    expect(getReleaseNotesPreview("123456", 4)).toBe("1234…");
  });
});
