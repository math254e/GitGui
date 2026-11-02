import type {
  DesktopBridge,
  DesktopUpdateActionResult,
  DesktopUpdateStatus,
} from "@gitgui/contracts/desktop";

export type DesktopUpdateAction = "check" | "download" | "install";

export interface DesktopUpdateSnapshot {
  readonly status: DesktopUpdateStatus;
  readonly pendingAction: DesktopUpdateAction | null;
}

export interface DesktopUpdateController {
  getSnapshot(): DesktopUpdateSnapshot;
  subscribe(listener: (snapshot: DesktopUpdateSnapshot) => void): () => void;
  start(): void;
  stop(): void;
  check(): Promise<void>;
  download(): Promise<void>;
  install(expectedVersion?: string): Promise<void>;
}

const INITIAL_STATUS: DesktopUpdateStatus = { phase: "disabled" };

/**
 * Owns updater event subscription and actions without depending on Svelte or
 * Electron globals. The root composition passes the optional desktop bridge.
 */
export function createDesktopUpdateController(
  bridge: DesktopBridge | null,
): DesktopUpdateController {
  let status = INITIAL_STATUS;
  let pendingAction: DesktopUpdateAction | null = null;
  let unsubscribe: (() => void) | undefined;
  let eventRevision = 0;
  let lifecycleGeneration = 0;
  let started = false;
  const listeners = new Set<(snapshot: DesktopUpdateSnapshot) => void>();

  const snapshot = (): DesktopUpdateSnapshot => ({ status, pendingAction });
  const emit = () => {
    const current = snapshot();
    for (const listener of listeners) listener(current);
  };
  const setStatus = (next: DesktopUpdateStatus) => {
    status = next;
    emit();
  };

  function start() {
    if (!bridge || started) return;
    started = true;
    lifecycleGeneration += 1;
    const generation = lifecycleGeneration;

    // Listen first: an event received while getUpdateStatus is in flight is
    // newer than that initial snapshot and must win.
    unsubscribe = bridge.onUpdateStatus((next) => {
      if (!started || generation !== lifecycleGeneration) return;
      eventRevision += 1;
      setStatus(next);
    });
    const revisionAtRead = eventRevision;
    void bridge.getUpdateStatus().then((next) => {
      if (started && generation === lifecycleGeneration && eventRevision === revisionAtRead) setStatus(next);
    }).catch((error: unknown) => {
      if (started && generation === lifecycleGeneration && eventRevision === revisionAtRead) {
        setStatus({ phase: "error", errorContext: "check", message: errorMessage(error) });
      }
    });
  }

  function stop() {
    started = false;
    lifecycleGeneration += 1;
    unsubscribe?.();
    unsubscribe = undefined;
    pendingAction = null;
    emit();
  }

  const run = async (
    action: DesktopUpdateAction,
    operation: () => Promise<DesktopUpdateStatus | DesktopUpdateActionResult>,
  ) => {
    if (!bridge || !started || pendingAction !== null) return;
    const generation = lifecycleGeneration;
    pendingAction = action;
    emit();
    const revisionAtStart = eventRevision;
    try {
      const result = await operation();
      const next = isActionResult(result) ? result.status : result;
      if (generation === lifecycleGeneration && eventRevision === revisionAtStart) setStatus(next);
    } catch (error) {
      if (generation === lifecycleGeneration && eventRevision === revisionAtStart) {
        setStatus({
          ...status,
          phase: "error",
          errorContext: action,
          message: errorMessage(error),
        });
      }
    } finally {
      if (generation !== lifecycleGeneration) return;
      pendingAction = null;
      emit();
    }
  };

  return {
    getSnapshot: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot());
      return () => listeners.delete(listener);
    },
    start,
    stop,
    check: () => run("check", () => bridge!.checkForUpdates()),
    download: () => run("download", () => bridge!.downloadUpdate()),
    install: (confirmedVersion) => run("install", () => {
      const expectedVersion = confirmedVersion ?? status.downloadedVersion ?? status.availableVersion ?? status.version;
      return bridge!.installUpdate(expectedVersion);
    }),
  };
}

function isActionResult(
  value: DesktopUpdateStatus | DesktopUpdateActionResult,
): value is DesktopUpdateActionResult {
  return "accepted" in value && "status" in value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The update request failed.";
}

export function getDesktopUpdateAction(status: DesktopUpdateStatus): DesktopUpdateAction {
  if (status.phase === "available" || (status.phase === "error" && status.errorContext === "download")) {
    return "download";
  }
  if (
    status.phase === "downloaded" ||
    (status.phase === "error" && status.errorContext === "install" && Boolean(status.downloadedVersion))
  ) {
    return "install";
  }
  return "check";
}

export function shouldShowDesktopUpdateControl(status: DesktopUpdateStatus): boolean {
  return status.phase !== "disabled" && (Boolean(status.availableVersion || status.downloadedVersion || status.message)
    || status.phase === "error" || status.phase === "downloading" || status.phase === "installing");
}

export function getDownloadedVersion(status: DesktopUpdateStatus): string | undefined {
  return status.downloadedVersion ?? status.availableVersion ?? status.version;
}

export function getDesktopReleaseUrl(status: DesktopUpdateStatus): string | null {
  const raw = status.releaseUrl?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password) {
      return null;
    }
    if (!/^\/[^/]+\/[^/]+\/releases(?:\/|$)/.test(url.pathname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function getReleaseNotesPreview(notes: string | undefined, limit = 600): string | null {
  const plainText = notes?.trim();
  if (!plainText) return null;
  return plainText.length > limit ? `${plainText.slice(0, limit).trimEnd()}…` : plainText;
}
