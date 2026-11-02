/** Narrow electron-updater adapter, following T3 Code's ElectronUpdater boundary. */
import electronUpdater from "electron-updater";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { normalizeUpdateFeedUrl } from "../lifecycle.js";
import type { UpdateEngine, UpdateEngineEvents } from "./desktop-updates.js";
import { defaultUpdateDiagnosticSink, reportUpdateFailure, type UpdateDiagnosticSink } from "./update-diagnostics.js";

const { autoUpdater, CancellationToken } = electronUpdater;

export function updateDisabledReason(packaged: boolean, platform: string, appImage: string | undefined,
  hasFeed: boolean, disabled: boolean): string | undefined {
  if (!packaged) return "Updates are available in packaged builds.";
  if (platform !== "win32" && platform !== "linux") return "Desktop updates support Windows and Linux.";
  if (platform === "linux" && !appImage) return "Automatic updates on Linux require the AppImage build. Update other packages manually.";
  if (disabled) return "Updates are disabled by GITGUI_DISABLE_AUTO_UPDATE.";
  if (!hasFeed) return "No packaged update feed is configured.";
}

export function packagedUpdateEngine(resourcesPath: string, diagnostics: UpdateDiagnosticSink = defaultUpdateDiagnosticSink): { engine: UpdateEngine; hasFeed: boolean } {
  const customFeed = normalizeUpdateFeedUrl(process.env.GITGUI_UPDATE_FEED_URL);
  const hasFeed = Boolean(customFeed) || existsSync(join(resourcesPath, "app-update.yml"));
  let cancellation: InstanceType<typeof CancellationToken> | undefined;
  const reportLateError = () => reportUpdateFailure(diagnostics, "background", "DesktopUpdaterReportedError");
  return { hasFeed, engine: {
    configure() {
      if (process.env.GITGUI_UPDATE_FEED_URL && !customFeed) {
        reportUpdateFailure(diagnostics, "feed", "ElectronUpdaterFeedConfigurationError");
        throw new Error("Invalid update feed");
      }
      // electron-updater's free-form logger includes URLs, paths and headers.
      // T3-style bounded diagnostics are emitted by the service instead.
      autoUpdater.logger = null;
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = false;
      autoUpdater.allowPrerelease = false;
      autoUpdater.channel = "latest";
      autoUpdater.allowDowngrade = false;
      autoUpdater.disableWebInstaller = true;
      if (customFeed) {
        try { autoUpdater.setFeedURL({ provider: "generic", url: customFeed }); }
        catch {
          reportUpdateFailure(diagnostics, "feed", "ElectronUpdaterFeedConfigurationError");
          throw new Error("Could not configure update feed");
        }
      }
    },
    subscribe(events: UpdateEngineEvents) {
      autoUpdater.removeListener("error", reportLateError);
      const progress = (info: { percent: number }) => events.progress(info.percent);
      autoUpdater.on("update-available", events.available);
      autoUpdater.on("update-not-available", events.current);
      autoUpdater.on("download-progress", progress);
      autoUpdater.on("update-downloaded", events.downloaded);
      autoUpdater.on("error", events.error);
      return () => {
        autoUpdater.removeListener("update-available", events.available);
        autoUpdater.removeListener("update-not-available", events.current);
        autoUpdater.removeListener("download-progress", progress);
        autoUpdater.removeListener("update-downloaded", events.downloaded);
        autoUpdater.removeListener("error", events.error);
        // A cancelled library operation can report after disposal during quit.
        autoUpdater.on("error", reportLateError);
      };
    },
    async check() { await autoUpdater.checkForUpdates(); },
    async download() {
      cancellation = new CancellationToken();
      try { await autoUpdater.downloadUpdate(cancellation); } finally { cancellation = undefined; }
    },
    install() {
      // electron-updater 6.8.9 leaves this latch set after an asynchronous
      // installer-spawn failure. Our service is the sole install owner and
      // holds its own reservation through recovery, so an admitted retry can
      // safely clear the stale latch. Keep this compatibility detail here.
      const installer = autoUpdater as typeof autoUpdater & { quitAndInstallCalled?: boolean };
      if (typeof installer.quitAndInstallCalled === "boolean") installer.quitAndInstallCalled = false;
      autoUpdater.quitAndInstall(true, true);
    },
    cancelDownload() { cancellation?.cancel(); },
  } };
}
