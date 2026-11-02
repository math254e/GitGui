/**
 * Adapted from T3 Code apps/desktop/src/updates/updateMachine.ts,
 * 70cd258d8aac43ea57494527b00bf36de3efa6c0.
 * Divergences: GitGui's separate desktop bridge uses optional fields and `phase`;
 * stable Windows/Linux only, plain-text release notes, explicit installing state.
 */
import type { DesktopUpdateStatus } from "@gitgui/contracts/desktop";

export type UpdateAction = "check" | "download" | "install";

export function initialUpdateState(currentVersion: string, disabledReason?: string): DesktopUpdateStatus {
  return { phase: disabledReason ? "disabled" : "idle", currentVersion, message: disabledReason };
}

export function startCheck(state: DesktopUpdateStatus, checkedAt: string): DesktopUpdateStatus {
  return { ...state, phase: "checking", checkedAt, message: undefined, errorContext: undefined };
}

export function noUpdate(state: DesktopUpdateStatus): DesktopUpdateStatus {
  return state.downloadedVersion
    ? { ...state, phase: "downloaded", availableVersion: state.downloadedVersion, version: state.downloadedVersion,
      downloadPercent: 100, message: undefined, errorContext: undefined }
    : { ...state, phase: "current", version: state.currentVersion, availableVersion: undefined,
      releaseNotes: undefined, releaseUrl: undefined, downloadPercent: undefined, message: undefined, errorContext: undefined };
}

export function updateAvailable(state: DesktopUpdateStatus, version: string, notes: string, releaseUrl: string): DesktopUpdateStatus {
  // A newer feed entry must not invalidate an installer the user already chose.
  if (state.downloadedVersion) return noUpdate(state);
  return { ...state, phase: "available", availableVersion: version, version, releaseNotes: notes,
    releaseUrl, downloadPercent: undefined, message: undefined, errorContext: undefined };
}

export function downloadComplete(state: DesktopUpdateStatus, version: string): DesktopUpdateStatus {
  return { ...state, phase: "downloaded", availableVersion: version, downloadedVersion: version,
    version, downloadPercent: 100, message: undefined, errorContext: undefined };
}

export function updateFailure(state: DesktopUpdateStatus, action: UpdateAction): DesktopUpdateStatus {
  if (action === "check" && state.downloadedVersion) return noUpdate(state);
  return { ...state,
    phase: action === "install" && state.downloadedVersion ? "downloaded"
      : action === "download" && state.availableVersion ? "available" : "error",
    errorContext: action,
    downloadPercent: state.downloadedVersion ? 100 : undefined,
    // Raw updater errors can contain URLs, headers, tokens, paths, or crash data.
    message: action === "check" ? "Could not check for updates. Check your connection and try again."
      : action === "download" ? "Could not download the update. Check your connection and disk space, then retry."
      : "Could not install the update. GitGui is restoring its local server; you can retry when it is ready.",
  };
}

export function isStableVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
}

export function releaseNotesText(value: unknown): string {
  const notes = typeof value === "string" ? value : Array.isArray(value)
    ? value.slice(0, 6).map((entry: unknown) => typeof entry === "object" && entry !== null
      && "note" in entry && typeof entry.note === "string" ? entry.note : "").join("\n\n") : "";
  return notes.slice(0, 32_000)
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(?:p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, "").replace(/\r/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .trim().slice(0, 8_000);
}
