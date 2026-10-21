/**
 * Vendored from T3 Code (`packages/client-runtime/src/connection/compatibility.ts`).
 *
 * Upstream: t3code @ 1688f965682d331da16a8c39f049592361f69c8d
 * (`v0.1.2-nightly.20261021.3473`).
 *
 * Divergences from upstream:
 * - T3 Code negotiates an orchestration protocol version through a query
 *   parameter. GitGui's protocol version is fixed, so the client compares the
 *   server's advertised version against its own and adds no query parameter.
 */
import { PROTOCOL_VERSION, type EnvironmentDescriptor } from "@gitgui/contracts/environment";

import { ConnectionBlockedError } from "./model.ts";

export function protocolCompatibilityError(
  descriptor: EnvironmentDescriptor,
): ConnectionBlockedError | null {
  const serverProtocolVersion = descriptor.protocolVersion;
  if (serverProtocolVersion === PROTOCOL_VERSION) {
    return null;
  }
  return serverProtocolVersion > PROTOCOL_VERSION
    ? new ConnectionBlockedError({
        reason: "unsupported",
        detail: `This client is not supported by this server. Update your app or use a compatible release to connect to ${descriptor.label}.`,
      })
    : new ConnectionBlockedError({
        reason: "unsupported",
        detail: `This client requires a newer server. Update GitGui on ${descriptor.label} to connect.`,
      });
}
