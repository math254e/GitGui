import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateEngineEvents } from "./desktop-updates.js";
import type { UpdateDiagnostic } from "./update-diagnostics.js";

const { updater } = vi.hoisted(() => ({ updater: {
  logger: undefined as unknown, autoDownload: true, autoInstallOnAppQuit: true,
  allowPrerelease: true, channel: "nightly", allowDowngrade: true, disableWebInstaller: false,
  setFeedURL: vi.fn(), on: vi.fn(), removeListener: vi.fn(),
} }));
vi.mock("electron-updater", () => ({ default: { autoUpdater: updater, CancellationToken: class {} } }));
vi.mock("node:fs", () => ({ existsSync: () => true }));
import { packagedUpdateEngine } from "./electron-updater.js";

const secret = "https://user:secret@updates.test?token=secret C:\\private\\update Authorization: Bearer secret";
let emitter: EventEmitter;
beforeEach(() => {
  vi.stubEnv("GITGUI_UPDATE_FEED_URL", "");
  emitter = new EventEmitter();
  updater.on.mockImplementation((event, listener) => emitter.on(event, listener));
  updater.removeListener.mockImplementation((event, listener) => emitter.removeListener(event, listener));
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetAllMocks(); });

describe("packaged updater diagnostic boundary", () => {
  it.each(["invalid", "set-feed"])("reports %s feed failure without including the feed or cause", (mode) => {
    const records: UpdateDiagnostic[] = [];
    vi.stubEnv("GITGUI_UPDATE_FEED_URL", mode === "invalid" ? secret : "https://updates.test/releases");
    if (mode === "set-feed") updater.setFeedURL.mockImplementation(() => { throw new Error(secret, { cause: { headers: secret } }); });
    const { engine } = packagedUpdateEngine("C:\\private", (record) => records.push(record));
    expect(() => engine.configure()).toThrow(mode === "invalid" ? "Invalid update feed" : "Could not configure update feed");
    expect(records).toEqual([{ component: "desktop-updates", operation: "feed", channel: "latest",
      errorTag: "ElectronUpdaterFeedConfigurationError" }]);
    expect(JSON.stringify(records)).not.toContain("secret");
  });

  it("keeps free-form library logging disabled and reports late errors after unsubscription", () => {
    const records: UpdateDiagnostic[] = [];
    const { engine } = packagedUpdateEngine("C:\\private", (record) => records.push(record));
    engine.configure();
    expect(updater.logger).toBeNull();
    const events: UpdateEngineEvents = { available: vi.fn(), current: vi.fn(), progress: vi.fn(),
      downloaded: vi.fn(), error: vi.fn() };
    const unsubscribe = engine.subscribe(events);
    const error = new Error(secret, { cause: { headers: secret } });
    emitter.emit("error", error);
    expect(events.error).toHaveBeenCalledExactlyOnceWith(error);
    expect(records).toEqual([]); // the service owns active-operation diagnostics
    unsubscribe();
    expect(() => emitter.emit("error", error)).not.toThrow();
    expect(events.error).toHaveBeenCalledOnce();
    expect(records).toEqual([{ component: "desktop-updates", operation: "background", channel: "latest",
      errorTag: "DesktopUpdaterReportedError" }]);
    expect(JSON.stringify(records)).not.toContain("secret");
    // Re-subscribing the same engine replaces its late-error observer.
    const unsubscribeAgain = engine.subscribe(events);
    expect(emitter.listenerCount("error")).toBe(1);
    unsubscribeAgain();
  });

  it("uses the default sink for invalid feeds without leaking the feed value", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("GITGUI_UPDATE_FEED_URL", secret);
    expect(() => packagedUpdateEngine("C:\\private").engine.configure()).toThrow("Invalid update feed");
    expect(log).toHaveBeenCalledWith("[gitgui-updates]", expect.objectContaining({ operation: "feed" }));
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
  });
});
