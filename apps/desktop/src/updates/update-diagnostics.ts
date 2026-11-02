/**
 * Adapted from T3 Code DesktopUpdates.ts error logging and its bounded-context
 * regression test (70cd258d8aac43ea57494527b00bf36de3efa6c0).
 * Divergence: GitGui's Promise service uses an injectable console sink instead
 * of DesktopObservability/Effect. Only locally selected tags and operations
 * cross this boundary; updater errors and their causes are never inspected.
 */
export type UpdateDiagnosticOperation = "feed" | "configure" | "check" | "download"
  | "install" | "recovery" | "background";

export type UpdateDiagnosticErrorTag = "ElectronUpdaterFeedConfigurationError"
  | "DesktopUpdateConfigureError" | "ElectronUpdaterCheckForUpdatesError"
  | "ElectronUpdaterDownloadUpdateError" | "ElectronUpdaterQuitAndInstallError"
  | "DesktopUpdateInstallPreparationError" | "DesktopUpdateInstallRecoveryError"
  | "DesktopUpdaterReportedError" | "DesktopUpdateEventHandlingError"
  | "DesktopUpdateIncompleteOperationError";

export type UpdateDiagnosticEvent = "update-available" | "download-progress" | "update-downloaded";

export interface UpdateDiagnostic {
  readonly component: "desktop-updates";
  readonly errorTag: UpdateDiagnosticErrorTag;
  readonly operation: UpdateDiagnosticOperation;
  readonly channel: "latest";
  readonly event?: UpdateDiagnosticEvent;
}

export type UpdateDiagnosticSink = (diagnostic: UpdateDiagnostic) => void;

/** Matches the desktop shell's existing stderr logging; active without setup. */
export const defaultUpdateDiagnosticSink: UpdateDiagnosticSink = (diagnostic) => {
  console.error("[gitgui-updates]", diagnostic);
};

export function reportUpdateFailure(sink: UpdateDiagnosticSink, operation: UpdateDiagnosticOperation,
  errorTag: UpdateDiagnosticErrorTag, event?: UpdateDiagnosticEvent): void {
  // No raw error argument, untrusted object spreads, coercion, or nested causes.
  // Diagnostics must never break recovery or release an action reservation.
  try {
    sink(Object.freeze({ component: "desktop-updates", errorTag, operation, channel: "latest",
      ...(event === undefined ? {} : { event }) }));
  } catch { /* A failed log sink cannot change update lifecycle behavior. */ }
}
