// Adapted from T3 Code 70cd258d8aac43ea57494527b00bf36de3efa6c0 packages/ssh/src/command.ts.
// Stable Effect process API, strict trust, bounded output, identity overrides and static errors:
// docs/ssh-manager.md. Remote helper input is stdin, never shell interpolation.
import { createHash } from "node:crypto";
import type { DesktopSshTarget } from "@gitgui/contracts/desktop";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { buildSshChildEnvironment, type SshAuthOptions } from "./auth.js";
import { HostProcessPlatform } from "./platform.js";
import { SshCommandError, SshInvalidTargetError } from "./errors.js";

export interface ResolvedSshTarget {
  readonly alias: string;
  readonly hostname: string;
  readonly username: string | null;
  readonly port: number | null;
  readonly identityFile?: string;
  readonly remoteLocator?: string;
  readonly hostKeyAlias?: string;
  readonly userKnownHostsFiles?: readonly string[];
  readonly globalKnownHostsFiles?: readonly string[];
  readonly proxy?: boolean;
}
export interface SshCommandResult { readonly stdout: string; readonly stderr: string; readonly exitCode?: number }
export interface RunSshCommandOptions extends SshAuthOptions {
  readonly preHostArgs?: readonly string[];
  readonly remoteCommandArgs?: readonly string[];
  readonly stdin?: string;
  readonly keepStdinOpen?: boolean;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}
export const resolveSshCommand = Effect.map(HostProcessPlatform, p => p === "win32" ? "ssh.exe" : "ssh");

export function parseSshResolveOutput(alias: string, stdout: string): ResolvedSshTarget {
  const values = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/u)) {
    const [key, ...rest] = line.trim().split(/\s+/u);
    if (key && rest.length && !values.has(key)) values.set(key, rest.join(" "));
  }
  return {
    alias, hostname: values.get("hostname") || alias, username: values.get("user") || null,
    port: /^\d+$/.test(values.get("port") ?? "") ? Number(values.get("port")) : null,
    ...(values.has("hostkeyalias") && values.get("hostkeyalias") !== "none" ? { hostKeyAlias: values.get("hostkeyalias") } : {}),
    ...(values.has("userknownhostsfile") ? { userKnownHostsFiles: splitConfigPaths(values.get("userknownhostsfile")!) } : {}),
    ...(values.has("globalknownhostsfile") ? { globalKnownHostsFiles: splitConfigPaths(values.get("globalknownhostsfile")!) } : {}),
    ...(["proxyjump", "proxycommand"].some(k => values.has(k) && values.get(k) !== "none") ? { proxy: true } : {}),
  };
}
function splitConfigPaths(value: string): string[] {
  return [...value.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3]);
}
export function targetConnectionKey(t: ResolvedSshTarget): string {
  return JSON.stringify([t.alias, t.hostname, t.username, t.port, t.identityFile ?? null, t.remoteLocator ?? null]);
}
export const remoteStateKey = (t: ResolvedSshTarget) => createHash("sha256").update(targetConnectionKey(t)).digest("hex");
export function buildSshHostSpec(t: ResolvedSshTarget): string {
  const destination = t.alias.trim() || t.hostname.trim();
  const invalid = (s: string) => !s || s.startsWith("-") || /[\s\x00-\x1f\x7f@]/u.test(s);
  if (invalid(destination) || (t.username !== null && invalid(t.username))) throw new SshInvalidTargetError({ message: "Invalid SSH host or user." });
  if (t.port !== null && (!Number.isInteger(t.port) || t.port < 1 || t.port > 65535)) throw new SshInvalidTargetError({ message: "Invalid SSH port." });
  if (t.identityFile !== undefined && (!t.identityFile || /[\x00-\x1f\x7f]/u.test(t.identityFile))) throw new SshInvalidTargetError({ message: "Invalid SSH identity path." });
  return t.username ? `${t.username}@${destination}` : destination;
}
export const buildSshHostSpecEffect = (target: ResolvedSshTarget) => Effect.try({ try: () => buildSshHostSpec(target), catch: () => new SshInvalidTargetError({ message: "Invalid SSH connection settings." }) });
export function baseSshArgs(t: ResolvedSshTarget, input?: { readonly batchMode?: "yes" | "no" }): string[] {
  return ["-o", `BatchMode=${input?.batchMode ?? "yes"}`, "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=yes",
    // A child belongs to this scope, never an unrelated multiplexed SSH master.
    "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ControlPersist=no",
    ...(t.port !== null ? ["-p", String(t.port)] : []), ...(t.identityFile ? ["-i", t.identityFile] : [])];
}
export const getLastNonEmptyOutputLine = (output: string) => output.trim().split(/\r?\n/u).reverse().find(s => s.trim()) ?? null;

export function commandFailure(stderr: string, exitCode: number | null): SshCommandError {
  // OpenSSH has no structured error protocol. Classify here, discard raw diagnostics
  // immediately, and carry typed categories through all IPC.
  let category: NonNullable<SshCommandError["category"]> = "transport";
  let reason: SshCommandError["reason"];
  let message = "SSH transport failed. Check the host and network connection.";
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|REVOKED HOST KEY|Offending .* key/i.test(stderr)) {
    category = "permission"; reason = "changed-host"; message = "SSH host key changed or was revoked. Resolve it in OpenSSH known_hosts before connecting.";
  } else if (/No .* host key is known|Host key verification failed/i.test(stderr)) {
    category = "permission"; reason = "unknown-host"; message = "SSH host identity requires verification.";
  } else if (/Permission denied \((?:publickey|password|keyboard-interactive|hostbased|gssapi-with-mic)|authentication failed|too many authentication failures/i.test(stderr)) {
    category = "authentication"; message = "SSH authentication was rejected.";
  } else if (/bad configuration|bad port|bad owner or permissions|bad permissions|no such identity|could not resolve hostname|invalid format/i.test(stderr)) {
    category = "configuration"; message = "OpenSSH rejected the connection configuration.";
  } else if (exitCode === 127 || /gitgui-server:.*(?:not found|not recognized)|unknown (?:subcommand|command).*ssh|unrecognized subcommand/i.test(stderr)) {
    category = "unsupported"; message = "The remote gitgui-server SSH helper is unavailable or unsupported. Install a compatible server on PATH.";
  }
  return new SshCommandError({ category, reason, message, command: ["ssh"], exitCode, stderr: "" });
}

export const collectProcessOutput = <E>(stream: Stream.Stream<Uint8Array, E>, limit = 1024 * 1024) => {
  let size = 0;
  return stream.pipe(Stream.mapEffect(chunk => {
    size += chunk.byteLength;
    return size > limit ? Effect.fail(new Error("SSH output exceeded the limit.")) : Effect.succeed(chunk);
  }), Stream.decodeText(), Stream.runFold(() => "", (a, b) => a + b));
};

/** Scoped local utility, used only by trusted SSH implementation code. */
export const runLocalCommand = Effect.fn("ssh.command.local")(function* (
  executable: string, args: readonly string[], options: {
    env?: NodeJS.ProcessEnv; stdin?: string; keepStdinOpen?: boolean; timeoutMs?: number; maxOutputBytes?: number;
  } = {},
) {
  return yield* Effect.scoped(Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(ChildProcess.make(executable, args, {
      env: options.env, extendEnv: true, windowsHide: true,
      stdin: { stream: options.stdin === undefined ? Stream.empty : Stream.make(new TextEncoder().encode(options.stdin)), endOnDone: !options.keepStdinOpen },
    })).pipe(Effect.mapError(() => commandFailure("", null)));
    yield* Effect.addFinalizer(() => child.kill({ killSignal: "SIGTERM", forceKillAfter: 2000 }).pipe(Effect.ignore));
    const [stdout, stderr, exitCode] = yield* Effect.all([
      collectProcessOutput(child.stdout, options.maxOutputBytes), collectProcessOutput(child.stderr, options.maxOutputBytes), child.exitCode,
    ], { concurrency: "unbounded" }).pipe(Effect.mapError(() => commandFailure("", null)));
    return { stdout, stderr, exitCode: Number(exitCode) };
  })).pipe(Effect.timeoutOrElse({ duration: options.timeoutMs ?? 60_000, orElse: () => Effect.fail(commandFailure("", null)) }));
});

export const runSshCommand = Effect.fn("ssh.command.run")(function* (target: ResolvedSshTarget, input: RunSshCommandOptions = {}) {
  return yield* Effect.scoped(Effect.gen(function* () {
    const host = yield* buildSshHostSpecEffect(target);
    const env = yield* buildSshChildEnvironment(input).pipe(Effect.mapError(() => commandFailure("", null)));
    const executable = yield* resolveSshCommand;
    const result = yield* runLocalCommand(executable, [
      ...baseSshArgs(target, { batchMode: input.batchMode ?? (input.interactiveAuth ? "no" : "yes") }),
      ...(input.preHostArgs ?? []), host, ...(input.remoteCommandArgs ?? []),
    ], { ...input, env });
    if (result.exitCode !== 0) return yield* commandFailure(result.stderr, result.exitCode);
    return { stdout: result.stdout, stderr: result.stderr };
  }));
});

export const resolveSshTarget = Effect.fn("ssh.command.resolve")(function* (profile: DesktopSshTarget) {
  const unresolved: ResolvedSshTarget = { alias: profile.host.trim(), hostname: profile.host.trim(), username: profile.user ?? null, port: profile.port ?? null, identityFile: profile.identityFile };
  yield* buildSshHostSpecEffect(unresolved);
  const result = yield* runSshCommand(unresolved, { preHostArgs: ["-G"], timeoutMs: 10_000 });
  return { ...parseSshResolveOutput(unresolved.alias, result.stdout), ...(profile.user ? { username: profile.user } : {}),
    ...(profile.port !== undefined ? { port: profile.port } : {}), identityFile: profile.identityFile, remoteLocator: profile.remoteDataDirectory };
});
