// Adapted from T3 Code 70cd258d8aac43ea57494527b00bf36de3efa6c0, packages/ssh/src/errors.ts.
// GitGui adaptations and limitations: see docs/ssh-primitives.md.
import * as Data from "effect/Data";
import type { DesktopSshFailureCategory } from "@gitgui/contracts/desktop";

/** Only static diagnostics cross IPC; command output and secrets never do. */
export class SshFailure extends Data.TaggedError("SshFailure")<{
  readonly category: DesktopSshFailureCategory;
  readonly message: string;
}> {}

export const cancelled = () => new SshFailure({ category: "cancelled", message: "SSH connection was cancelled or connections are closed." });

export function toSshFailure(error: unknown): SshFailure {
  if (error instanceof SshFailure) return error;
  if (error instanceof SshCommandError) return new SshFailure({ category: error.category ?? "transport", message: error.message });
  if (error instanceof SshInvalidTargetError) return new SshFailure({ category: "configuration", message: "Invalid SSH connection settings." });
  if (error instanceof SshPasswordPromptError) return new SshFailure({ category: "authentication", message: "SSH authentication was cancelled, expired, or rejected." });
  return new SshFailure({ category: "transport", message: "SSH operation failed. Try connecting again." });
}

export class SshHostDiscoveryError extends Data.TaggedError("SshHostDiscoveryError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class SshInvalidTargetError extends Data.TaggedError("SshInvalidTargetError")<{
  readonly message: string;
}> {}

export class SshCommandError extends Data.TaggedError("SshCommandError")<{
  readonly category?: DesktopSshFailureCategory;
  readonly reason?: "unknown-host" | "changed-host";
  readonly message: string;
  readonly command: readonly string[];
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout?: string;
  readonly cause?: unknown;
}> {}

export class SshLaunchError extends Data.TaggedError("SshLaunchError")<{
  readonly message: string;
  readonly stdout: string;
  readonly cause?: unknown;
}> {}

export class SshPairingError extends Data.TaggedError("SshPairingError")<{
  readonly message: string;
  readonly stdout: string;
  readonly cause?: unknown;
}> {}

export class SshHttpBridgeError extends Data.TaggedError("SshHttpBridgeError")<{
  readonly message: string;
  readonly status?: number;
  readonly cause?: unknown;
}> {}

export class SshReadinessError extends Data.TaggedError("SshReadinessError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class SshPasswordPromptError extends Data.TaggedError("SshPasswordPromptError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
