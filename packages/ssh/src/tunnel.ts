// Adapted from T3 Code 70cd258d8aac43ea57494527b00bf36de3efa6c0 packages/ssh/src/tunnel.ts.
// Keeps Deferred pending entries, entry scopes and scoped auth secrets. GitGui's
// per-waiter Rust acquisitions, tombstones and durable cleanup journal are deliberate
// ownership corrections. Direct HTTP remains the client boundary. See docs/ssh-manager.md.
// Historical EnvironmentIds stay opaque across ensure, claim and cleanup journals.
import { isValidEnvironmentId } from "@gitgui/contracts/environment";
import type { DesktopCredential, DesktopPreparedConnection, DesktopSshCleanup, DesktopSshRequest, DesktopSshTarget } from "@gitgui/contracts/desktop";
import type { SshHostRequest, SshHostResponse } from "@gitgui/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import type { ChildProcessSpawner } from "effect/process";
import { discoverSshHosts } from "./config.js";
import { remoteStateKey, resolveSshTarget, type ResolvedSshTarget } from "./command.js";
import { SshCommandError, SshFailure, SshInvalidTargetError, cancelled, toSshFailure } from "./errors.js";
import { cleanupOutcome, locatorFor, requireOutcome, runHostOperation, UUID, type HostOperation } from "./runner.js";
import { openTunnel, type SshTunnel } from "./transport.js";
import { confirmUnknownHost, type SshHostTrustRequest } from "./trust.js";
import type { SshAuthOptions } from "./auth.js";

export type SshServices = ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path;
type OperationError = SshFailure | SshCommandError | SshInvalidTargetError;
export interface SshManagerDependencies {
  readonly resolve: (target: DesktopSshTarget) => Effect.Effect<ResolvedSshTarget, OperationError>;
  readonly host: (target: ResolvedSshTarget, operation: HostOperation, request: SshHostRequest, auth: SshAuthOptions) => Effect.Effect<SshHostResponse, OperationError>;
  readonly tunnel: (target: ResolvedSshTarget, port: number, auth: SshAuthOptions) => Effect.Effect<SshTunnel, OperationError, Scope.Scope>;
  readonly trust: (target: ResolvedSshTarget, confirm: (input: SshHostTrustRequest) => Effect.Effect<boolean, SshFailure>) => Effect.Effect<void, SshFailure>;
}
export interface SshEnvironmentManagerOptions {
  readonly stateDirectory: string;
  readonly requestPassword?: (target: ResolvedSshTarget, prompt: string) => Effect.Effect<string | null, SshFailure>;
  readonly requestHostTrust?: (request: SshHostTrustRequest) => Effect.Effect<boolean, SshFailure>;
  /** Deterministic lifecycle tests replace boundaries, never resource ownership. */
  readonly dependencies?: SshManagerDependencies;
}
interface TunnelEntry {
  readonly key: string;
  readonly scope: Scope.Closeable;
  readonly users: Set<string>;
  readonly pending: Deferred.Deferred<SshTunnel, SshFailure>;
}
interface Acquisition {
  readonly id: string;
  readonly profile: DesktopSshTarget;
  readonly scope: Scope.Closeable;
  readonly ready: Deferred.Deferred<DesktopPreparedConnection, SshFailure>;
  readonly finished: Deferred.Deferred<DesktopSshCleanup>;
  request: SshHostRequest;
  target?: ResolvedSshTarget;
  tunnel?: TunnelEntry;
  connection?: DesktopPreparedConnection;
  claimAttempted: boolean;
  cancelled: boolean;
  cleanup: DesktopSshCleanup;
}
interface JournalRecord {
  version: 1;
  target: ResolvedSshTarget;
  request: SshHostRequest;
  claimAttempted: boolean;
}
const journalRequestSchema = Schema.Struct({
  version: Schema.Literal(1), acquisitionId: Schema.String,
  expectedEnvironmentId: Schema.NullOr(Schema.String), instanceId: Schema.NullOr(Schema.String),
  locator: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("default") }),
    Schema.Struct({ kind: Schema.Literal("directory"), path: Schema.String, environmentId: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("legacy"), stateKey: Schema.String, environmentId: Schema.String }),
  ]),
});
const profileKey = (target: DesktopSshTarget) => JSON.stringify([target.host, target.user ?? null, target.port ?? null, target.identityFile ?? null, target.remoteDataDirectory ?? null]);
// Never evict a tombstone and admit a delayed ensure with the same ID. Bound
// admission instead; retired IDs contain only the idempotent cleanup outcome.
const MAX_OPERATION_IDS = 8192;
const assertIdentity = (actual: string | null, expected: string | null) => {
  if (!actual || (expected && actual !== expected)) throw new SshFailure({ category: "identity", message: "The SSH server identity does not match the selected environment." });
};

export const makeSshEnvironmentManager = Effect.fn("ssh.manager.make")(function* (options: SshEnvironmentManagerOptions) {
  const managerScope = yield* Scope.Scope;
  const context = yield* Effect.context<SshServices>();
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dependencies: SshManagerDependencies = options.dependencies ?? {
    resolve: target => resolveSshTarget(target).pipe(Effect.provide(context)),
    host: (target, operation, request, auth) => runHostOperation(target, operation, request, auth).pipe(Effect.provide(context)),
    tunnel: (target, port, auth) => openTunnel(target, port, auth).pipe(Effect.provide(context)),
    trust: (target, confirm) => confirmUnknownHost(target, confirm).pipe(Effect.provide(context), Effect.mapError(toSshFailure)),
  };
  const acquisitions = new Map<string, Acquisition>();
  const retired = new Map<string, DesktopSshCleanup>();
  const tunnels = new Map<string, TunnelEntry>();
  const authSecrets = new Map<string, string>();
  const journalDirectory = path.join(options.stateDirectory, "cleanup");
  let closed = false;
  let closing: Deferred.Deferred<void> | undefined;
  const assertOpen = () => closed ? Effect.fail(cancelled()) : Effect.void;
  const assertActive = (op: Acquisition) => closed || op.cancelled ? Effect.fail(cancelled()) : Effect.void;
  const reserveId = (id: string) => Effect.suspend(() => {
    if (retired.has(id)) return Effect.void;
    if (retired.size >= MAX_OPERATION_IDS) return Effect.fail(new SshFailure({ category: "configuration", message: "Too many SSH operations. Restart the desktop application." }));
    retired.set(id, "stopped");
    return Effect.void;
  });
  const journalFile = (id: string) => path.join(journalDirectory, `${id}.json`);
  const writeJournal = (op: Acquisition) => Effect.gen(function* () {
    if (!op.target) return;
    yield* fs.makeDirectory(journalDirectory, { recursive: true, mode: 0o700 });
    const record: JournalRecord = { version: 1, target: op.target, request: op.request, claimAttempted: op.claimAttempted };
    const file = journalFile(op.id);
    yield* fs.writeFileString(`${file}.tmp`, JSON.stringify(record), { mode: 0o600 });
    yield* fs.rename(`${file}.tmp`, file);
  }).pipe(Effect.mapError(() => new SshFailure({ category: "configuration", message: "Could not persist SSH acquisition ownership." })));

  const authOptions = (target: ResolvedSshTarget): SshAuthOptions => {
    const secret = authSecrets.get(remoteStateKey(target));
    return secret === undefined ? { batchMode: "yes", interactiveAuth: false } : { authSecret: secret, batchMode: "no", interactiveAuth: true };
  };
  const withAuth = <A, R>(target: ResolvedSshTarget, operation: (auth: SshAuthOptions) => Effect.Effect<A, OperationError, R>): Effect.Effect<A, SshFailure, R> => {
    const key = remoteStateKey(target);
    const attempt = (passwordPrompts: number, trustPrompted: boolean): Effect.Effect<A, SshFailure, R> => operation(authOptions(target)).pipe(
      Effect.catch(error => {
        if (error instanceof SshCommandError && error.reason === "unknown-host" && !trustPrompted && options.requestHostTrust) {
          return dependencies.trust(target, input => options.requestHostTrust!(input).pipe(
            Effect.timeoutOrElse({ duration: 180_000, orElse: () => Effect.fail(new SshFailure({ category: "permission", message: "SSH host confirmation expired." })) }),
          )).pipe(Effect.andThen(attempt(passwordPrompts, true)));
        }
        const failure = toSshFailure(error);
        if (failure.category !== "authentication") return Effect.fail(failure);
        authSecrets.delete(key);
        if (!options.requestPassword || passwordPrompts >= 2) return Effect.fail(failure);
        return options.requestPassword(target, `Password or key passphrase for ${target.username ? `${target.username}@` : ""}${target.alias}`).pipe(
          Effect.timeoutOrElse({ duration: 180_000, orElse: () => Effect.fail(new SshFailure({ category: "authentication", message: "SSH authentication prompt expired." })) }),
          Effect.flatMap(secret => {
            if (secret === null || secret.length === 0 || secret.length > 16 * 1024 || /[\r\n\0]/.test(secret)) return Effect.fail(new SshFailure({ category: "authentication", message: "SSH authentication was cancelled or rejected." }));
            authSecrets.set(key, secret);
            return attempt(passwordPrompts + 1, trustPrompted);
          }),
        );
      }),
    );
    return attempt(0, false);
  };
  const host = (op: Acquisition, operation: HostOperation) => {
    const attempt = withAuth(op.target!, auth => dependencies.host(op.target!, operation, op.request, auth));
    // Pairing runs after ensure's 300s provisional deadline starts. Two native
    // prompts must share one budget, leaving 90s for HTTP/RPC/save/claim. Ensure
    // retains its independent prompt/start budgets. See docs/ssh-manager.md.
    return operation === "pairing" ? attempt.pipe(Effect.timeoutOrElse({ duration: 210_000, orElse: () => Effect.fail(new SshFailure({ category: "authentication", message: "SSH pairing authentication expired. Try connecting again." })) })) : attempt;
  };

  const releaseTunnel = (op: Acquisition) => Effect.gen(function* () {
    const entry = op.tunnel;
    op.tunnel = undefined;
    if (!entry) return;
    entry.users.delete(op.id);
    if (entry.users.size === 0) {
      // Remove by instance, before closing; a replacement can already be pending.
      if (tunnels.get(entry.key) === entry) tunnels.delete(entry.key);
      yield* Scope.close(entry.scope, Exit.void);
    }
  });
  const cleanup = (op: Acquisition) => Effect.gen(function* () {
    op.cancelled = true;
    yield* Deferred.fail(op.ready, cancelled());
    yield* releaseTunnel(op);
    if (op.target) {
      // Never prompt in a finalizer. Keep the journal on host/network failure.
      op.cleanup = yield* dependencies.host(op.target, op.claimAttempted && op.request.instanceId ? "release" : "cancel", op.request, authOptions(op.target)).pipe(
        Effect.map(cleanupOutcome), Effect.catch(() => Effect.succeed("cleanup-pending" as const)),
        Effect.timeoutOrElse({ duration: 15_000, orElse: () => Effect.succeed("cleanup-pending" as const) }),
      );
      if (op.cleanup !== "cleanup-pending") yield* fs.remove(journalFile(op.id)).pipe(Effect.ignore);
    } else op.cleanup = "stopped";
    // Keep auth only while another operation to this target is alive.
    if (op.target && ![...acquisitions.values()].some(other => other !== op && !other.cancelled && other.target && remoteStateKey(other.target) === remoteStateKey(op.target!))) authSecrets.delete(remoteStateKey(op.target));
    yield* Deferred.succeed(op.finished, op.cleanup);
    retired.set(op.id, op.cleanup);
    // Scopes, Deferreds, descriptors and profiles must not accumulate across
    // reconnects. Only the bounded tombstone survives for stale IPC messages.
    if (acquisitions.get(op.id) === op) acquisitions.delete(op.id);
  });

  const acquireTunnel = (op: Acquisition, remote: SshHostResponse): Effect.Effect<SshTunnel, SshFailure> => Effect.uninterruptibleMask(restore => Effect.gen(function* () {
    const key = `${remoteStateKey(op.target!)}:${remote.instanceId}:${remote.port}`;
    let entry = tunnels.get(key);
    const reused = entry !== undefined;
    if (!entry) {
      const scope = yield* Scope.make("sequential");
      const pending = yield* Deferred.make<SshTunnel, SshFailure>();
      entry = { key, scope, users: new Set(), pending };
      const created = entry;
      tunnels.set(key, entry);
      yield* Scope.addFinalizer(scope, Deferred.fail(pending, cancelled()).pipe(Effect.asVoid));
      const opening = withAuth(op.target!, auth => dependencies.tunnel(op.target!, remote.port!, auth)).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.onExit(exit => Deferred.done(pending, exit).pipe(Effect.asVoid)),
      );
      yield* restore(opening).pipe(Effect.forkIn(scope));
      yield* Scope.addFinalizer(scope, Effect.sync(() => { if (tunnels.get(key) === created) tunnels.delete(key); }));
    }
    entry.users.add(op.id);
    op.tunnel = entry;
    const tunnel = yield* restore(Deferred.await(entry.pending));
    // Probe shared entries on every acquisition; stale tunnels never look ready.
    const checked = yield* restore(Effect.exit(tunnel.probe));
    if (Exit.isFailure(checked)) {
      // A failed probe retires this entry from admission. Existing successful
      // owners retain their exact resource until they release it; a cancelled
      // or reconnecting waiter cannot destroy another owner's tunnel.
      if (tunnels.get(key) === entry) tunnels.delete(key);
      yield* releaseTunnel(op);
      if (reused) return yield* restore(acquireTunnel(op, remote));
      return yield* Effect.failCause(checked.cause);
    }
    const descriptor = checked.value;
    yield* Effect.try({ try: () => assertIdentity(descriptor.environmentId, remote.environmentId), catch: toSshFailure });
    return { ...tunnel, descriptor };
  }));

  const reconcile = (target: ResolvedSshTarget) => Effect.gen(function* () {
    if (!(yield* fs.exists(journalDirectory))) return;
    const files = yield* fs.readDirectory(journalDirectory);
    for (const file of files.slice(0, 1024)) {
      const id = file.slice(0, -5);
      if (!file.endsWith(".json") || !UUID.test(id) || (acquisitions.has(id) && !acquisitions.get(id)!.cancelled)) continue;
      const stat = yield* fs.stat(journalFile(id));
      if (stat.size > 32 * 1024) continue;
      const bytes = yield* fs.readFileString(journalFile(id)).pipe(Effect.orElseSucceed(() => ""));
      if (Buffer.byteLength(bytes) > 32 * 1024) continue;
      let record: JournalRecord;
      try {
        record = JSON.parse(bytes);
        const request = Schema.decodeUnknownSync(journalRequestSchema, { onExcessProperty: "error" })(record.request);
        record.request = request;
        if (record.version !== 1 || typeof record.claimAttempted !== "boolean" || record.request.acquisitionId !== id || !record.target || remoteStateKey({ ...record.target, remoteLocator: undefined }) !== remoteStateKey({ ...target, remoteLocator: undefined }) ||
            (record.request.instanceId !== null && !UUID.test(record.request.instanceId)) || (record.request.expectedEnvironmentId !== null && !isValidEnvironmentId(record.request.expectedEnvironmentId))) continue;
        const locator = record.request.locator;
        if (locator.kind !== "default" && (!isValidEnvironmentId(locator.environmentId) || locator.environmentId !== record.request.expectedEnvironmentId ||
          (locator.kind === "directory" ? !locator.path.startsWith("/") || /[\x00-\x1f]/.test(locator.path) : !/^[A-Za-z0-9_-]{1,48}$/.test(locator.stateKey)))) continue;
      } catch { continue; }
      const result = yield* dependencies.host(target, record.claimAttempted && record.request.instanceId ? "release" : "cancel", record.request, authOptions(target)).pipe(
        Effect.map(cleanupOutcome), Effect.catch(() => Effect.succeed("cleanup-pending" as const)),
      );
      if (result !== "cleanup-pending") {
        yield* fs.remove(journalFile(id)).pipe(Effect.ignore);
        if (retired.has(id)) retired.set(id, result);
      }
    }
  }).pipe(Effect.timeoutOrElse({ duration: 15_000, orElse: () => Effect.void }), Effect.ignore);

  const prepare = (op: Acquisition) => Effect.gen(function* () {
    yield* assertActive(op);
    op.target = yield* dependencies.resolve(op.profile).pipe(Effect.mapError(toSshFailure));
    yield* assertActive(op);
    // Persist the locally reserved ID before the first remote invocation.
    yield* writeJournal(op);
    const remote = yield* host(op, "ensure");
    yield* Effect.try({ try: () => {
      requireOutcome(remote, "ready");
      assertIdentity(remote.environmentId, op.request.expectedEnvironmentId);
      if (!remote.instanceId || !remote.port || !remote.remoteDataDirectory || !remote.ownership) throw new SshFailure({ category: "unsupported", message: "Incomplete remote SSH ownership response." });
    }, catch: toSshFailure });
    yield* assertActive(op);
    op.request = { ...op.request, instanceId: remote.instanceId, expectedEnvironmentId: remote.environmentId,
      locator: { kind: "directory", path: remote.remoteDataDirectory!, environmentId: remote.environmentId! } };
    yield* writeJournal(op);
    const tunnel = yield* acquireTunnel(op, remote);
    yield* assertActive(op);
    op.connection = { httpUrl: `http://127.0.0.1:${tunnel.localPort}`, descriptor: tunnel.descriptor, ssh: { operationId: op.id, remoteDataDirectory: remote.remoteDataDirectory! } };
    // Reconcile only a matching, successfully authenticated route. No old secret
    // or arbitrary command is stored in the journal.
    yield* reconcile(op.target);
    yield* assertActive(op);
    return op.connection;
  });

  const ensureEnvironment = (profile: DesktopSshTarget, request: DesktopSshRequest): Effect.Effect<DesktopPreparedConnection, SshFailure> => Effect.uninterruptibleMask(restore => Effect.gen(function* () {
    yield* assertOpen();
    if (!request || !UUID.test(request.operationId) || (request.expectedEnvironmentId !== undefined && !isValidEnvironmentId(request.expectedEnvironmentId))) return yield* new SshFailure({ category: "configuration", message: "Invalid SSH acquisition identity." });
    if (retired.has(request.operationId) || acquisitions.has(request.operationId)) return yield* cancelled();
    if (yield* fs.exists(journalFile(request.operationId)).pipe(Effect.mapError(() => new SshFailure({ category: "configuration", message: "Could not inspect SSH acquisition ownership." })))) return yield* cancelled();
    const locator = yield* Effect.try({ try: () => locatorFor(profile, request.expectedEnvironmentId), catch: toSshFailure });
    const op = yield* Effect.try({ try: (): Acquisition => {
      // Reserve and publish atomically with respect to another IPC fiber. A
      // cancel must see either no work (and tombstone it) or this exact scope.
      if (retired.has(request.operationId)) throw cancelled();
      if (retired.size >= MAX_OPERATION_IDS) throw new SshFailure({ category: "configuration", message: "Too many SSH operations. Restart the desktop application." });
      const value: Acquisition = { id: request.operationId, profile, scope: Scope.makeUnsafe("sequential"), ready: Deferred.makeUnsafe<DesktopPreparedConnection, SshFailure>(), finished: Deferred.makeUnsafe<DesktopSshCleanup>(),
        request: { version: 1, acquisitionId: request.operationId, locator, expectedEnvironmentId: request.expectedEnvironmentId ?? null, instanceId: null },
        claimAttempted: false, cancelled: false, cleanup: "cleanup-pending" };
      retired.set(value.id, "cleanup-pending");
      acquisitions.set(value.id, value);
      return value;
    }, catch: toSshFailure });
    const scope = op.scope;
    yield* Scope.addFinalizer(scope, cleanup(op));
    yield* restore(prepare(op)).pipe(Effect.onExit(exit => Deferred.done(op.ready, Exit.isFailure(exit) && Exit.hasInterrupts(exit) ? Exit.fail(cancelled()) : exit).pipe(Effect.asVoid)), Effect.forkIn(scope));
    return yield* restore(Deferred.await(op.ready)).pipe(Effect.onExit(exit => Exit.isFailure(exit) ? Scope.close(scope, Exit.void) : Effect.void));
  }));
  const current = (id: string, expectedId: string) => Effect.gen(function* () {
    yield* assertOpen();
    const op = acquisitions.get(id);
    if (!op || op.cancelled || !op.connection || !isValidEnvironmentId(expectedId)) return yield* cancelled();
    yield* Effect.try({ try: () => assertIdentity(op.connection!.descriptor.environmentId, expectedId), catch: toSshFailure });
    return op;
  });
  const runInOperation = <A>(op: Acquisition, effect: Effect.Effect<A, SshFailure>) => Effect.gen(function* () {
    const deferred = yield* Deferred.make<A, SshFailure>();
    yield* effect.pipe(Effect.onExit(exit => Deferred.done(deferred, Exit.isFailure(exit) && Exit.hasInterrupts(exit) ? Exit.fail(cancelled()) : exit).pipe(Effect.asVoid)), Effect.forkIn(op.scope));
    return yield* Deferred.await(deferred);
  });
  const issuePairingCredential = (id: string, expectedId: string): Effect.Effect<DesktopCredential, SshFailure> => Effect.gen(function* () {
    const op = yield* current(id, expectedId);
    return yield* runInOperation(op, Effect.gen(function* () {
      const result = yield* host(op, "pairing");
      yield* assertActive(op);
      yield* Effect.try({ try: () => {
        requireOutcome(result, "ready"); assertIdentity(result.environmentId, expectedId);
        if (result.instanceId !== op.request.instanceId) throw new SshFailure({ category: "identity", message: "The SSH server instance changed before pairing." });
      }, catch: toSshFailure });
      if (!result.pairing || !result.pairing.credential || result.pairing.credential.length > 4096 || !Number.isFinite(result.pairing.expiresIn) || result.pairing.expiresIn <= 0 || result.pairing.expiresIn > 600) return yield* new SshFailure({ category: "unsupported", message: "Invalid SSH pairing response." });
      return { kind: "pairing", token: result.pairing.credential, expiresAt: Date.now() + result.pairing.expiresIn * 1000 } as DesktopCredential;
    }));
  });
  const claimConnection = (id: string, expectedId: string): Effect.Effect<void, SshFailure> => Effect.gen(function* () {
    const op = yield* current(id, expectedId);
    return yield* runInOperation(op, Effect.gen(function* () {
      // A lost claim response may already be committed remotely. Cleanup must
      // release the exact handle in that case rather than cancel-and-retain.
      op.claimAttempted = true;
      yield* writeJournal(op);
      const response = yield* host(op, "claim");
      yield* assertActive(op);
      yield* Effect.try({ try: () => { requireOutcome(response, "claimed"); assertIdentity(response.environmentId, expectedId); if (response.instanceId !== op.request.instanceId) throw new SshFailure({ category: "identity", message: "The SSH server instance changed before claim." }); }, catch: toSshFailure });
    }));
  });
  const cancelConnection = (id: string): Effect.Effect<DesktopSshCleanup, SshFailure> => Effect.gen(function* () {
    if (!UUID.test(id)) return yield* new SshFailure({ category: "configuration", message: "Invalid SSH acquisition identity." });
    // Cancellation can precede ensure's IPC arrival. The ID remains tombstoned
    // across close/reopen and can never be used for a new acquisition.
    yield* reserveId(id);
    const op = acquisitions.get(id);
    if (!op) {
      // After a desktop restart the sender knows the ID before the manager has
      // a live scope. A surviving journal is ownership uncertainty, not exit.
      if (retired.get(id) === "stopped" && (yield* fs.exists(journalFile(id)).pipe(Effect.orElseSucceed(() => true)))) retired.set(id, "cleanup-pending");
      return retired.get(id)!;
    }
    op.cancelled = true;
    yield* Scope.close(op.scope, Exit.void);
    return yield* Deferred.await(op.finished);
  });
  const disconnectEnvironment = (target: DesktopSshTarget) => Effect.forEach([...acquisitions.values()].filter(op => {
    if (profileKey(op.profile) === profileKey(target)) return true;
    // Onboarding persists the canonical locator returned by ensure. The original
    // profile may have selected the default/legacy directory, so compare that
    // resolved, identity-pinned locator without broadening removal to the host.
    const locator = op.request.locator;
    return profileKey({ ...op.profile, remoteDataDirectory: undefined }) === profileKey({ ...target, remoteDataDirectory: undefined }) &&
      target.remoteDataDirectory !== undefined && locator.kind === "directory" && locator.path === target.remoteDataDirectory &&
      locator.environmentId === op.request.expectedEnvironmentId;
  }), op => cancelConnection(op.id).pipe(Effect.map(outcome => ({ operationId: op.id, outcome }))), { concurrency: "unbounded" });
  const close = Effect.suspend(() => {
    closed = true;
    if (closing) return Deferred.await(closing);
    closing = Deferred.makeUnsafe<void>();
    const done = closing;
    return Effect.forEach([...acquisitions.values()], op => cancelConnection(op.id).pipe(Effect.ignore), { concurrency: "unbounded", discard: true }).pipe(
      Effect.ensuring(Effect.sync(() => authSecrets.clear())), Effect.ensuring(Deferred.succeed(done, undefined)),
    );
  });
  const reopen = Effect.gen(function* () { if (closing) yield* Deferred.await(closing); closing = undefined; closed = false; });
  yield* Scope.addFinalizer(managerScope, close);
  return {
    ensureEnvironment, issuePairingCredential, claimConnection, cancelConnection, disconnectEnvironment, close, reopen,
    discoverHosts: () => discoverSshHosts({}).pipe(Effect.provide(context), Effect.mapError(toSshFailure)),
  };
});
export type SshEnvironmentManager = Effect.Success<ReturnType<typeof makeSshEnvironmentManager>>;
