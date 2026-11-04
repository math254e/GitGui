import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { SshHostRequest, SshHostResponse, EnvironmentDescriptor } from "@gitgui/contracts";
import { makeSshEnvironmentManager, type SshEnvironmentManagerOptions, type SshManagerDependencies } from "../src/tunnel.js";
import type { HostOperation } from "../src/runner.js";
import { SshFailure } from "../src/errors.js";

export const environmentId = "11111111-1111-4111-8111-111111111111";
export const secondEnvironmentId = "22222222-2222-4222-8222-222222222222";
export const instanceId = "33333333-3333-4333-8333-333333333333";
export const descriptor = (second = false): EnvironmentDescriptor => ({
  schemaVersion: 1, environmentId: second ? secondEnvironmentId : environmentId, label: "fixture", serverVersion: "0.1.0", protocolVersion: 2,
  platform: "linux", architecture: "x86_64", capabilities: [], auth: { required: true, bootstrapMethods: ["pairing"], sessionMethods: ["bearer"] }, endpoints: [],
});
export function hostResponse(request: SshHostRequest, outcome: SshHostResponse["outcome"] = "ready", second = false): SshHostResponse {
  return { version: 1, acquisitionId: request.acquisitionId, outcome, instanceId, environmentId: second ? secondEnvironmentId : environmentId, remoteDataDirectory: second ? "/state/second" : "/state/first",
    port: 3774, ownership: "managed", expiresAtUnixMs: Date.now() + 120_000, message: null, pairing: null };
}
export async function fixture(options: Partial<SshEnvironmentManagerOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "gitgui-ssh-manager-"));
  const scope = Scope.makeUnsafe("sequential");
  const state = {
    hostCalls: [] as { operation: HostOperation; request: SshHostRequest; alias: string; auth: unknown }[],
    tunnels: 0, stopped: [] as number[], live: new Set<number>(),
    onHost: undefined as undefined | ((operation: HostOperation, request: SshHostRequest) => Effect.Effect<SshHostResponse, SshFailure> | undefined),
    beforeTunnel: undefined as undefined | Effect.Effect<void, SshFailure>,
    beforeStop: undefined as undefined | Effect.Effect<void>,
    probe: undefined as undefined | ((id: number) => Effect.Effect<EnvironmentDescriptor, SshFailure>),
    external: false,
  };
  const dependencies: SshManagerDependencies = {
    resolve: profile => Effect.succeed({ alias: profile.host, hostname: profile.host, username: profile.user ?? "alice", port: profile.port ?? 22, identityFile: profile.identityFile, remoteLocator: profile.remoteDataDirectory }),
    trust: () => Effect.void,
    host: (target, operation, request, auth) => Effect.suspend(() => {
      state.hostCalls.push({ operation, request: structuredClone(request), alias: target.alias, auth });
      const custom = state.onHost?.(operation, request);
      if (custom) return custom;
      const response = hostResponse(request, operation === "claim" ? "claimed" : operation === "cancel" ? "stopped" : operation === "release" ? "released" : "ready", target.alias === "second");
      if (state.external) { response.ownership = "external"; if (operation === "cancel" || operation === "release") response.outcome = "retained"; }
      if (operation === "pairing") response.pairing = { credential: "fixture-one-use-secret", expiresIn: 600, scopes: ["repository:read", "repository:operate", "repository:manage"] };
      return Effect.succeed(response);
    }),
    tunnel: target => Effect.gen(function* () {
      const id = yield* Effect.acquireRelease(Effect.sync(() => { const id = ++state.tunnels; state.live.add(id); return id; }), id => Effect.gen(function* () {
        state.stopped.push(id); state.live.delete(id); if (state.beforeStop) yield* state.beforeStop;
      }));
      if (state.beforeTunnel) yield* state.beforeTunnel;
      const value = descriptor(target.alias === "second");
      return { localPort: 40000 + id, descriptor: value, probe: Effect.suspend(() => state.probe?.(id) ?? Effect.succeed(value)) };
    }),
  };
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
  const manager = await Effect.runPromise(makeSshEnvironmentManager({ stateDirectory: directory, dependencies, ...options }).pipe(Effect.provideService(Scope.Scope, scope), Effect.provide(NodeServices.layer)));
  const acquire = (host = "first", id = randomUUID()) => ({ id, promise: run(manager.ensureEnvironment({ kind: "ssh", host }, { operationId: id })) });
  return { manager, state, directory, run, acquire, async dispose() {
    await run(Scope.close(scope, Exit.void));
    await rm(directory, { recursive: true, force: true });
  } };
}
