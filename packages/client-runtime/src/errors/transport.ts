/**
 * Vendored from T3 Code (`packages/client-runtime/src/errors/transport.ts`).
 *
 * Upstream: t3code @ 1688f965682d331da16a8c39f049592361f69c8d
 * (`v0.1.2-nightly.20261021.3473`).
 *
 * Divergences from upstream:
 * - The patterns name the GitGui server instead of the T3 server, and the
 *   transport failures of the GitGui envelope are recognized.
 */
import { NETWORK_BLOCKING_HINT, UNRESPONSIVE_HOST_HINT } from "./network.ts";

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const TRANSPORT_ERROR_PATTERNS = [
  /\bSocketCloseError\b/i,
  /\bSocketOpenError\b/i,
  /\bSocket is not connected\b/i,
  /Unable to connect to the GitGui WebSocket\./i,
  // The RPC session appends the network hint for relayed connections. Any
  // other trailing text means a different error that the user should still see.
  new RegExp(
    `\\b(?:is not connected|disconnected|stopped responding|could not establish a WebSocket connection)\\.(?: ${escapeRegExp(NETWORK_BLOCKING_HINT)})?$`,
    "i",
  ),
  new RegExp(`\\bstopped responding for \\d+s\\. ${escapeRegExp(UNRESPONSIVE_HOST_HINT)}$`, "i"),
  /\bClientProtocolError\b/i,
  /\bRpcClientError\b/i,
  /\bGitGuiRpcError\b/i,
  /\bping timeout\b/i,
] as const;

export function isTransportConnectionErrorMessage(message: string | null | undefined): boolean {
  if (typeof message !== "string") {
    return false;
  }

  const normalizedMessage = message.trim();
  if (normalizedMessage.length === 0) {
    return false;
  }

  return TRANSPORT_ERROR_PATTERNS.some((pattern) => pattern.test(normalizedMessage));
}

export function sanitizeThreadErrorMessage(message: string | null | undefined): string | null {
  return isTransportConnectionErrorMessage(message) ? null : (message ?? null);
}
