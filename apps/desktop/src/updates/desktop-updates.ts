/**
 * Adapted from T3 Code apps/desktop/src/updates/DesktopUpdates.ts,
 * 70cd258d8aac43ea57494527b00bf36de3efa6c0.
 * Divergences: Promise service matches GitGui's existing Electron lifecycle;
 * stable Windows/Linux only; injected installer/local-server boundary; no remote
 * control or channel switching. The shared Effect connection runtime is unchanged.
 * Bounded failure annotations use update-diagnostics.ts rather than Effect logging.
 */
import type { DesktopUpdateActionResult, DesktopUpdateStatus } from "@gitgui/contracts/desktop";
import { defaultUpdateDiagnosticSink, reportUpdateFailure, type UpdateDiagnosticErrorTag,
  type UpdateDiagnosticEvent, type UpdateDiagnosticOperation, type UpdateDiagnosticSink } from "./update-diagnostics.js";
import { downloadComplete, initialUpdateState, isStableVersion, noUpdate, releaseNotesText,
  startCheck, updateAvailable, updateFailure, type UpdateAction } from "./update-machine.js";

// T3 DesktopUpdates.ts PREPARED_INSTALL_CHECK_WAIT, same upstream snapshot.
const PREPARED_INSTALL_CHECK_WAIT_MS = 90_000;

export interface UpdateEngineEvents {
  available(info: unknown): void;
  current(): void;
  progress(percent: unknown): void;
  downloaded(info: unknown): void;
  error(error: unknown): void;
}

export interface UpdateEngine {
  configure(): void;
  subscribe(events: UpdateEngineEvents): () => void;
  check(): Promise<void>;
  download(): Promise<void>;
  install(): void;
  cancelDownload(): void;
}

export interface UpdateLifecycle {
  stopForInstall(): Promise<void>;
  recoverFromInstall(): Promise<void>;
}

export interface DesktopUpdatesOptions {
  currentVersion: string;
  disabledReason?: string;
  /** Build/deployment-owned URL, never renderer input. */
  releaseBaseUrl: string;
  diagnostics?: UpdateDiagnosticSink;
}

export class DesktopUpdates {
  private state: DesktopUpdateStatus;
  private action: UpdateAction | "recovery" | null = null;
  private readonly listeners = new Set<(state: DesktopUpdateStatus) => void>();
  private unsubscribe?: () => void;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private pollTimer?: ReturnType<typeof setInterval>;
  private recovery?: Promise<void>;
  private started = false;
  private disposed = false;
  private installerInvoked = false;
  private readonly checkWaiters = new Set<() => void>();

  constructor(private readonly engine: UpdateEngine, private readonly lifecycle: UpdateLifecycle,
    private readonly options: DesktopUpdatesOptions) {
    this.state = initialUpdateState(options.currentVersion, options.disabledReason);
  }

  get status(): DesktopUpdateStatus { return { ...this.state }; }
  get isInstallActive(): boolean { return this.action === "install" || this.action === "recovery"; }

  subscribe(listener: (state: DesktopUpdateStatus) => void): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.started || this.disposed || this.options.disabledReason) return;
    this.started = true;
    try {
      this.unsubscribe = this.engine.subscribe({
        available: (raw) => {
          if (this.action !== "check") return;
          const info = readInfo(raw);
          if (!info) {
            this.report("check", "DesktopUpdateEventHandlingError", "update-available");
            this.set(updateFailure(this.state, "check")); return;
          }
          this.set(updateAvailable(this.state, info.version, releaseNotesText(info.releaseNotes),
            `${this.options.releaseBaseUrl}/tag/v${encodeURIComponent(info.version)}`));
        },
        current: () => { if (this.action === "check") this.set(noUpdate(this.state)); },
        progress: (percent) => {
          if (this.action !== "download") return;
          if (typeof percent !== "number" || !Number.isFinite(percent)) {
            this.report("download", "DesktopUpdateEventHandlingError", "download-progress"); return;
          }
          const next = Math.max(0, Math.min(100, Math.floor(percent)));
          if (next !== this.state.downloadPercent) this.set({ ...this.state, phase: "downloading", downloadPercent: next });
        },
        downloaded: (raw) => {
          if (this.action !== "download") return;
          const info = readInfo(raw);
          if (info && info.version === this.state.availableVersion) this.set(downloadComplete(this.state, info.version));
          else {
            this.report("download", "DesktopUpdateEventHandlingError", "update-downloaded");
            this.set(updateFailure(this.state, "download"));
          }
        },
        error: () => {
          // Like T3's DesktopUpdaterReportedError, annotate the owning operation,
          // never the free-form error argument (including its nested causes).
          this.report(this.action ?? "background", "DesktopUpdaterReportedError");
          if (this.action === "install" && this.installerInvoked) void this.recoverInstall();
          else if (this.action === "check" || this.action === "download") this.set(updateFailure(this.state, this.action));
          // Background errors do not discard an already verified installer.
        },
      });
      this.engine.configure();
    } catch {
      this.report("configure", "DesktopUpdateConfigureError");
      this.set({ ...this.state, phase: "disabled", message: "The packaged update feed could not be configured." }); return;
    }
    this.startupTimer = setTimeout(() => { void this.check(); }, 15_000);
    this.pollTimer = setInterval(() => { void this.check(); }, 4 * 60_000);
    this.startupTimer.unref?.();
    this.pollTimer.unref?.();
  }

  async check(): Promise<DesktopUpdateStatus> {
    if (!this.canAct()) return this.status;
    this.action = "check";
    this.set(startCheck(this.state, new Date().toISOString()));
    try {
      await this.engine.check();
      if (this.state.phase === "checking") {
        this.report("check", "DesktopUpdateIncompleteOperationError");
        this.set(updateFailure(this.state, "check"));
      }
    } catch {
      this.report("check", "ElectronUpdaterCheckForUpdatesError");
      this.set(updateFailure(this.state, "check"));
    }
    finally {
      if (this.action === "check") this.action = null;
      for (const finished of [...this.checkWaiters]) finished();
    }
    return this.status;
  }

  async download(): Promise<DesktopUpdateActionResult> {
    if (!this.canAct() || this.state.phase !== "available" || !this.state.availableVersion) return this.result(false);
    this.action = "download";
    this.set({ ...this.state, phase: "downloading", downloadPercent: 0, message: undefined, errorContext: undefined });
    try {
      await this.engine.download();
      // A resolved download without the matching verified event is not ready.
      if (this.status.phase === "downloading") {
        this.report("download", "DesktopUpdateIncompleteOperationError");
        this.set(updateFailure(this.state, "download"));
      }
    } catch {
      this.report("download", "ElectronUpdaterDownloadUpdateError");
      this.set(updateFailure(this.state, "download"));
    }
    finally { if (this.action === "download") this.action = null; }
    return this.result(true);
  }

  async install(expectedVersion?: string): Promise<DesktopUpdateActionResult> {
    // T3's prepared install waits for an admitted check, then revalidates both
    // version and action ownership. The wait itself never reserves installation.
    while (this.started && !this.disposed && this.state.phase !== "disabled"
      && this.action === "check" && expectedVersion !== undefined) {
      if (this.state.downloadedVersion !== expectedVersion) return this.result(false);
      if (!await this.waitForCheck()) return this.result(false);
    }
    if (!this.canAct() || this.state.phase !== "downloaded" || !this.state.downloadedVersion
      || (expectedVersion !== undefined && expectedVersion !== this.state.downloadedVersion)) return this.result(false);
    this.action = "install";
    this.installerInvoked = false;
    let installAttempted = false;
    this.set({ ...this.state, phase: "installing", message: undefined, errorContext: undefined });
    try {
      await this.lifecycle.stopForInstall();
      if (this.disposed) { await this.recoverInstall(); return this.result(false); }
      installAttempted = true;
      this.installerInvoked = true;
      this.engine.install();
      if (this.recovery) await this.recovery;
      // Reservation lasts until actual quit or failure recovery, not invocation.
    } catch {
      this.report("install", installAttempted
        ? "ElectronUpdaterQuitAndInstallError" : "DesktopUpdateInstallPreparationError");
      await this.recoverInstall();
    }
    return this.result(true);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const finished of [...this.checkWaiters]) finished();
    clearTimeout(this.startupTimer);
    clearInterval(this.pollTimer);
    this.engine.cancelDownload();
    this.unsubscribe?.();
    this.listeners.clear();
  }

  private canAct(): boolean {
    return this.started && !this.disposed && this.state.phase !== "disabled" && this.action === null;
  }

  private waitForCheck(): Promise<boolean> {
    return new Promise((resolve) => {
      const finish = () => { cleanup(); resolve(true); };
      const timer = setTimeout(() => { cleanup(); resolve(false); }, PREPARED_INSTALL_CHECK_WAIT_MS);
      const cleanup = () => { clearTimeout(timer); this.checkWaiters.delete(finish); };
      this.checkWaiters.add(finish);
    });
  }

  private report(operation: UpdateDiagnosticOperation, errorTag: UpdateDiagnosticErrorTag, event?: UpdateDiagnosticEvent): void {
    reportUpdateFailure(this.options.diagnostics ?? defaultUpdateDiagnosticSink, operation, errorTag, event);
  }

  private result(accepted: boolean): DesktopUpdateActionResult { return { accepted, status: this.status }; }

  private set(state: DesktopUpdateStatus): void {
    if (this.disposed) return;
    this.state = state;
    for (const listener of this.listeners) listener(this.status);
  }

  private recoverInstall(): Promise<void> {
    if (this.recovery) return this.recovery;
    if (this.action !== "install") return Promise.resolve();
    const preparationFailed = !this.installerInvoked;
    this.action = "recovery";
    this.installerInvoked = false;
    this.recovery = (async () => {
      let recovered = true;
      try { await this.lifecycle.recoverFromInstall(); } catch {
        recovered = false;
        this.report("recovery", "DesktopUpdateInstallRecoveryError");
      }
      this.set({ ...updateFailure(this.state, "install"), message: recovered
        ? preparationFailed
          ? "GitGui could not finish preparing the local server. Wait for Git operations to finish, then retry."
          : "Could not install the update. The local server has been restored; you can retry."
        : "Could not restore the local server after the failed update. Restart GitGui before retrying." });
      this.action = null;
    })().finally(() => { this.recovery = undefined; });
    return this.recovery;
  }
}

function readInfo(raw: unknown): { version: string; releaseNotes?: unknown } | undefined {
  if (!raw || typeof raw !== "object" || !("version" in raw) || !isStableVersion(raw.version)) return;
  return { version: raw.version, releaseNotes: "releaseNotes" in raw ? raw.releaseNotes : undefined };
}
