// Adapted from T3 Code 70cd258d8aac43ea57494527b00bf36de3efa6c0 tunnel.ts
// startSshTunnel / waitForHttpReady. Effect 4.0.5 and direct, bounded HTTP decoding
// are GitGui adaptations. Only a locally reserved 127.0.0.1 port is accepted.
import { createServer } from "node:net";
import type { EnvironmentDescriptor as WireDescriptor } from "@gitgui/contracts";
import { EnvironmentDescriptor, PROTOCOL_VERSION } from "@gitgui/contracts/environment";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { baseSshArgs, buildSshHostSpecEffect, collectProcessOutput, commandFailure, resolveSshCommand, type ResolvedSshTarget } from "./command.js";
import { buildSshChildEnvironment, type SshAuthOptions } from "./auth.js";
import { SshFailure, toSshFailure } from "./errors.js";

export const reserveLocalPort = Effect.callback<number, SshFailure>(resume => {
  const server = createServer();
  let cancelled = false;
  server.once("error", () => resume(Effect.fail(new SshFailure({ category: "transport", message: "Could not reserve a local SSH forward port." }))));
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => { if (!cancelled && address && typeof address !== "string") resume(Effect.succeed(address.port)); });
  });
  return Effect.sync(() => { cancelled = true; server.close(); });
});
const unavailable = () => new SshFailure({ category: "transport", message: "The forwarded SSH environment did not become ready." });

export function fetchDescriptor(localPort: number, timeoutMs = 1000): Effect.Effect<WireDescriptor, SshFailure> {
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) return Effect.fail(unavailable());
  return Effect.tryPromise({ try: async signal => {
    const response = await fetch(`http://127.0.0.1:${localPort}/.well-known/gitgui/environment`, { signal, redirect: "error", headers: { accept: "application/json" } });
    if (!response.ok || !response.body) { void response.body?.cancel(); throw unavailable(); }
    const reader = response.body.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 64 * 1024) throw new SshFailure({ category: "unsupported", message: "The SSH environment descriptor exceeded its size limit." });
        chunks.push(next.value);
      }
    } finally { void reader.cancel().catch(() => undefined); }
    let descriptor: WireDescriptor;
    try { const decoded = Schema.decodeUnknownSync(EnvironmentDescriptor)(JSON.parse(Buffer.concat(chunks).toString("utf8"))); descriptor = { ...decoded, capabilities: [...decoded.capabilities], auth: { ...decoded.auth, bootstrapMethods: [...decoded.auth.bootstrapMethods], sessionMethods: [...decoded.auth.sessionMethods] }, endpoints: decoded.endpoints.map(e => ({ ...e })) }; }
    catch { throw new SshFailure({ category: "unsupported", message: "The SSH environment descriptor is invalid." }); }
    if (descriptor.schemaVersion !== 1 || descriptor.protocolVersion !== PROTOCOL_VERSION) throw new SshFailure({ category: "unsupported", message: "The SSH server protocol is incompatible with this client." });
    return descriptor;
  }, catch: e => e instanceof SshFailure ? e : unavailable() }).pipe(Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.fail(unavailable()) }));
}
export function waitForDescriptor(localPort: number, timeoutMs = 20_000): Effect.Effect<WireDescriptor, SshFailure> {
  const attempt: Effect.Effect<WireDescriptor, SshFailure> = Effect.suspend(() => fetchDescriptor(localPort).pipe(
    Effect.catch(e => e.category === "transport" ? Effect.sleep(100).pipe(Effect.andThen(attempt)) : Effect.fail(e)),
  ));
  return attempt.pipe(Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.fail(unavailable()) }));
}
export interface SshTunnel {
  readonly localPort: number;
  readonly descriptor: WireDescriptor;
  readonly probe: Effect.Effect<WireDescriptor, SshFailure>;
}
export const openTunnel = Effect.fn("ssh.transport.open")(function* (target: ResolvedSshTarget, remotePort: number, auth: SshAuthOptions = {}) {
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) return yield* new SshFailure({ category: "unsupported", message: "Invalid SSH helper listener port." });
  const host = yield* buildSshHostSpecEffect(target);
  const localPort = yield* reserveLocalPort;
  const env = yield* buildSshChildEnvironment(auth).pipe(Effect.mapError(toSshFailure));
  const executable = yield* resolveSshCommand;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(ChildProcess.make(executable, [
    ...baseSshArgs(target, auth), "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
    "-n", "-N", "-L", `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`, host,
  ], { env, extendEnv: true, windowsHide: true, stdin: { stream: Stream.empty, endOnDone: true } })).pipe(Effect.mapError(toSshFailure));
  yield* Effect.addFinalizer(() => child.kill({ killSignal: "SIGTERM", forceKillAfter: 2000 }).pipe(Effect.ignore));
  const exited = yield* Deferred.make<never, SshFailure>();
  yield* Effect.all([collectProcessOutput(child.stderr, 64 * 1024), child.exitCode], { concurrency: "unbounded" }).pipe(
    Effect.flatMap(([stderr, code]) => Deferred.fail(exited, toSshFailure(commandFailure(stderr, Number(code))))),
    Effect.catch(e => Deferred.fail(exited, toSshFailure(e))), Effect.forkScoped,
  );
  yield* collectProcessOutput(child.stdout, 64 * 1024).pipe(Effect.ignore, Effect.forkScoped);
  const descriptor = yield* Effect.raceFirst(waitForDescriptor(localPort), Deferred.await(exited));
  const probe = Effect.gen(function* () {
    if (!(yield* child.isRunning.pipe(Effect.mapError(toSshFailure)))) return yield* unavailable();
    return yield* Effect.raceFirst(fetchDescriptor(localPort), Deferred.await(exited));
  });
  return { localPort, descriptor, probe } satisfies SshTunnel;
});
