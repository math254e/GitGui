/**
 * Error presentation helpers.
 *
 * Protocol, transport, and Git failures all reach the UI as unknown values.
 * These helpers turn them into the single sentence the user reads.
 */

export function formatError(caught: unknown): string {
  if (typeof caught === "object" && caught && "message" in caught) {
    const reason = errorReason(caught);
    return reason ? `${caught.message} ${reason}` : `${caught.message}`;
  }

  return String(caught);
}

export function errorReason(caught: object): string {
  const directStderr =
    "stderr" in caught && typeof caught.stderr === "string" ? caught.stderr : "";
  if (directStderr.trim()) {
    return directStderr.trim();
  }

  if (
    !("details" in caught) ||
    typeof caught.details !== "object" ||
    caught.details === null ||
    Array.isArray(caught.details)
  ) {
    return "";
  }

  const details = caught.details;
  if ("stderr" in details && typeof details.stderr === "string" && details.stderr.trim()) {
    return details.stderr.trim();
  }

  if ("status" in details && typeof details.status === "number") {
    return `Git exited with status ${details.status}.`;
  }

  return "";
}

export function summarizeGitError(caught: unknown): string {
  const reason =
    typeof caught === "object" && caught !== null ? errorReason(caught).toLowerCase() : String(caught).toLowerCase();
  if (reason.includes("local changes") && reason.includes("overwritten")) {
    return "Local changes would be overwritten.";
  }
  if (reason.includes("conflict")) {
    return "Conflicts need to be resolved.";
  }
  if (reason.includes("did not match any") || reason.includes("pathspec")) {
    return "That branch was not found.";
  }
  if (reason.includes("already exists")) {
    return "That branch already exists.";
  }
  if (reason.includes("not a git repository")) {
    return "This is not a Git repository.";
  }
  return formatError(caught) || "Git could not complete the operation.";
}

const CONNECTION_ERROR_CODES = [
  "connection_failed",
  "not_connected",
  "websocket_unavailable",
  "incompatible_protocol",
  "unauthorized",
  "forbidden",
  "disconnected",
];

/** True when a failure means the environment is no longer reachable. */
export function isConnectionError(caught: unknown): boolean {
  if (typeof caught !== "object" || caught === null) return false;
  if ("kind" in caught) return true;
  if (!("code" in caught)) return false;
  return typeof caught.code === "string" && CONNECTION_ERROR_CODES.includes(caught.code);
}
