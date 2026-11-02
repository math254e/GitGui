/**
 * Adapted from T3 Code apps/desktop/src/updates/DesktopUpdates.ts,
 * 70cd258d8aac43ea57494527b00bf36de3efa6c0.
 * Divergences: Promise service matches GitGui's existing Electron lifecycle;
 * stable Windows/Linux only; injected installer/local-server boundary; no remote
 * control or channel switching. The shared Effect connection runtime is unchanged.
 */
import type { DesktopUpdateActionResult, DesktopUpdateStatus } from "@gitgui/contracts/desktop";
import { downloadComplete, initialUpdateState, isStableVersion, noUpdate, releaseNotesText,
  startCheck, updateAvailable, updateFailure, type UpdateAction } from "./update-machine.js";

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
    this.unsubscribe = this.engine.subscribe({
      available: (raw) => {
        if (this.action !== "check") return;
        const info = readInfo(raw);
        if (!info) { this.set(updateFailure(this.state, "check")); return; }
        this.set(updateAvailable(this.state, info.version, releaseNotesText(info.releaseNotes),
          `${this.options.releaseBaseUrl}/tag/v${encodeURIComponent(info.version)}`));
      },
      current: () => { if (this.action === "check") this.set(noUpdate(this.state)); },
      progress: (percent) => {
        if (this.action !== "download" || typeof percent !== "number" || !Number.isFinite(percent)) return;
        const next = Math.max(0, Math.min(100, Math.floor(percent)));
        if (next !== this.state.downloadPercent) this.set({ ...this.state, phase: "downloading", downloadPercent: next });
      },
      downloaded: (raw) => {
        if (this.action !== "download") return;
        const info = readInfo(raw);
        if (info && info.version === this.state.availableVersion) this.set(downloadComplete(this.state, info.version));
        else this.set(updateFailure(this.state, "download"));
      },
      error: () => {
        if (this.action === "install" && this.installerInvoked) void this.recoverInstall();
        else if (this.action === "check" || this.action === "download") this.set(updateFailure(this.state, this.action));
        // Background errors do not discard an already verified installer.
      },
    });
    try { this.engine.configure(); }
    catch { this.set({ ...this.state, phase: "disabled", message: "The packaged update feed could not be configured." }); return; }
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
      if (this.state.phase === "checking") this.set(updateFailure(this.state, "check"));
    } catch { this.set(updateFailure(this.state, "check")); }
    finally { if (this.action === "check") this.action = null; }
    return this.status;
  }

  async download(): Promise<DesktopUpdateActionResult> {
    if (!this.canAct() || this.state.phase !== "available" || !this.state.availableVersion) return this.result(false);
    this.action = "download";
    this.set({ ...this.state, phase: "downloading", downloadPercent: 0, message: undefined, errorContext: undefined });
    try {
      await this.engine.download();
      // A resolved download without the matching verified event is not ready.
      if (this.status.phase === "downloading") this.set(updateFailure(this.state, "download"));
    } catch { this.set(updateFailure(this.state, "download")); }
    finally { if (this.action === "download") this.action = null; }
    return this.result(true);
  }

  async install(expectedVersion?: string): Promise<DesktopUpdateActionResult> {
    if (!this.canAct() || this.state.phase !== "downloaded" || !this.state.downloadedVersion
      || (expectedVersion !== undefined && expectedVersion !== this.state.downloadedVersion)) return this.result(false);
    this.action = "install";
    this.installerInvoked = false;
    this.set({ ...this.state, phase: "installing", message: undefined, errorContext: undefined });
    try {
      await this.lifecycle.stopForInstall();
      if (this.disposed) { await this.recoverInstall(); return this.result(false); }
      this.installerInvoked = true;
      this.engine.install();
      if (this.recovery) await this.recovery;
      // Reservation lasts until actual quit or failure recovery, not invocation.
    } catch { await this.recoverInstall(); }
    return this.result(true);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.startupTimer);
    clearInterval(this.pollTimer);
    this.engine.cancelDownload();
    this.unsubscribe?.();
    this.listeners.clear();
  }

  private canAct(): boolean {
    return this.started && !this.disposed && this.state.phase !== "disabled" && this.action === null;
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
      try { await this.lifecycle.recoverFromInstall(); } catch { recovered = false; }
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
