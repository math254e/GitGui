import type { ProtocolError } from "@gitgui/contracts";

export class GitGuiClientError extends Error {
  readonly code: string;
  readonly details: ProtocolError["details"];
  readonly requestId?: string;

  constructor(message: string, options: { code?: string; details?: ProtocolError["details"]; requestId?: string } = {}) {
    super(message);
    this.name = "GitGuiClientError";
    this.code = options.code ?? "client_error";
    this.details = options.details;
    this.requestId = options.requestId;
  }
}

export function protocolErrorToClientError(error: ProtocolError, requestId?: string): GitGuiClientError {
  return new GitGuiClientError(error.message, {
    code: error.code,
    details: error.details,
    requestId,
  });
}

export function isUnauthorizedError(error: unknown): boolean {
  if (!(error instanceof GitGuiClientError)) return false;
  return error.code === "unauthorized" || error.code === "authentication_required" || error.code === "forbidden";
}

export function connectionError(message: string, details?: unknown): GitGuiClientError {
  return new GitGuiClientError(message, { code: "connection_failed", details: toJsonDetails(details) });
}

function toJsonDetails(details: unknown): ProtocolError["details"] {
  return details === undefined ? undefined : (details as ProtocolError["details"]);
}
