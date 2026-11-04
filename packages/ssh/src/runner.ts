// Adapted from T3 Code 70cd258d8aac43ea57494527b00bf36de3efa6c0 tunnel.ts
// launch/pair/stop boundaries. GitGui uses the Rust ownership protocol, not shell scripts.
// Historical EnvironmentIds are opaque; acquisition and instance IDs remain UUIDs.
import { isValidEnvironmentId } from "@gitgui/contracts/environment";
import type { DesktopSshCleanup, DesktopSshTarget } from "@gitgui/contracts/desktop";
import type { SshEnvironmentLocator, SshHostRequest, SshHostResponse } from "@gitgui/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { runSshCommand, type ResolvedSshTarget } from "./command.js";
import type { SshAuthOptions } from "./auth.js";
import { SshFailure } from "./errors.js";

export type HostOperation = "ensure" | "claim" | "cancel" | "release" | "probe" | "pairing";
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const hostResponseSchema = Schema.Struct({
  version: Schema.Number, acquisitionId: Schema.String,
  outcome: Schema.Literals(["ready", "claimed", "cancelled", "released", "stopped", "retained", "cleanup-pending", "not-running", "unsupported", "invalid-request", "incompatible", "identity-mismatch", "ambiguous", "failed"]),
  instanceId: Schema.NullOr(Schema.String), environmentId: Schema.NullOr(Schema.String), remoteDataDirectory: Schema.NullOr(Schema.String),
  port: Schema.NullOr(Schema.Number), ownership: Schema.NullOr(Schema.Literals(["managed", "external"])), expiresAtUnixMs: Schema.NullOr(Schema.Number),
  message: Schema.NullOr(Schema.String), pairing: Schema.NullOr(Schema.Struct({ credential: Schema.String, expiresIn: Schema.Number, scopes: Schema.Array(Schema.String) })),
});
const incompatible = () => new SshFailure({ category: "unsupported", message: "The remote SSH helper returned an incompatible response. Install a compatible gitgui-server." });

export function locatorFor(target: DesktopSshTarget, expectedEnvironmentId?: string): SshEnvironmentLocator {
  if (target.remoteDataDirectory !== undefined) {
    if (!expectedEnvironmentId || !isValidEnvironmentId(expectedEnvironmentId) || !target.remoteDataDirectory.startsWith("/") || /[\x00-\x1f]/.test(target.remoteDataDirectory)) {
      throw new SshFailure({ category: "configuration", message: "An existing SSH environment directory requires its saved environment identity." });
    }
    return { kind: "directory", path: target.remoteDataDirectory, environmentId: expectedEnvironmentId };
  }
  if (expectedEnvironmentId) {
    // This reproduces the OLD key only to select an existing directory. It is
    // never a new resource identity, and the helper must verify the saved environment identity.
    const oldKey = `${target.user ?? ""}@${target.host}:${target.port ?? 22}:${target.identityFile ?? ""}`;
    return { kind: "legacy", stateKey: Buffer.from(oldKey).toString("base64url").slice(0, 48), environmentId: expectedEnvironmentId };
  }
  return { kind: "default" };
}
export function decodeHostResponse(stdout: string, acquisitionId: string, operation: HostOperation): SshHostResponse {
  if (Buffer.byteLength(stdout) > 16 * 1024 || stdout.trim().split(/\r?\n/).length !== 1) throw incompatible();
  let response: SshHostResponse;
  try { const decoded = Schema.decodeUnknownSync(hostResponseSchema, { onExcessProperty: "error" })(JSON.parse(stdout)); response = { ...decoded, pairing: decoded.pairing ? { ...decoded.pairing, scopes: [...decoded.pairing.scopes] } : null }; }
  catch { throw incompatible(); }
  if (response.version !== 1 || response.acquisitionId !== acquisitionId || (response.instanceId !== null && !UUID.test(response.instanceId)) ||
      (response.environmentId !== null && !isValidEnvironmentId(response.environmentId)) || (response.port !== null && (!Number.isInteger(response.port) || response.port < 1 || response.port > 65535)) ||
      (response.remoteDataDirectory !== null && (!response.remoteDataDirectory.startsWith("/") || response.remoteDataDirectory.length > 4096 || /[\x00-\x1f]/.test(response.remoteDataDirectory))) ||
      (response.expiresAtUnixMs !== null && (!Number.isSafeInteger(response.expiresAtUnixMs) || response.expiresAtUnixMs < 0)) ||
      (operation !== "pairing" && response.pairing !== null)) throw incompatible();
  return response;
}
export const runHostOperation = Effect.fn("ssh.runner.operation")(function* (
  target: ResolvedSshTarget, operation: HostOperation, request: SshHostRequest, auth: SshAuthOptions = {},
) {
  const stdin = `${JSON.stringify(request)}\n`;
  if (!UUID.test(request.acquisitionId) || Buffer.byteLength(stdin) > 16 * 1024) return yield* new SshFailure({ category: "configuration", message: "Invalid SSH helper request." });
  const result = yield* runSshCommand(target, {
    ...auth, remoteCommandArgs: [`gitgui-server ssh ${operation} --json`], stdin,
    keepStdinOpen: operation === "ensure", timeoutMs: operation === "ensure" ? 90_000 : operation === "pairing" ? 10_000 : 15_000,
    maxOutputBytes: 16 * 1024,
  });
  return yield* Effect.try({ try: () => decodeHostResponse(result.stdout, request.acquisitionId, operation), catch: incompatible });
});
export function requireOutcome(response: SshHostResponse, outcome: "ready" | "claimed"): SshHostResponse {
  if (response.outcome === outcome) return response;
  switch (response.outcome) {
    case "identity-mismatch": throw new SshFailure({ category: "identity", message: "The SSH environment identity does not match the saved environment." });
    case "ambiguous": throw new SshFailure({ category: "configuration", message: "The saved SSH environment directory is ambiguous. Select the existing directory explicitly." });
    case "incompatible": case "unsupported": throw incompatible();
    case "invalid-request": throw new SshFailure({ category: "configuration", message: "The remote SSH helper rejected the connection settings." });
    case "cancelled": case "stopped": case "released": throw new SshFailure({ category: "cancelled", message: "The SSH acquisition was cancelled or expired." });
    default: throw new SshFailure({ category: "transport", message: "The remote SSH environment is unavailable." });
  }
}
export function cleanupOutcome(response: SshHostResponse): DesktopSshCleanup {
  switch (response.outcome) {
    case "cancelled": case "not-running": case "stopped": return "stopped";
    case "released": return "released";
    case "retained": return "retained";
    default: return "cleanup-pending";
  }
}
