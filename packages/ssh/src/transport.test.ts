// Upstream-derived command deadline, tunnel exit and readiness failure cases from
// T3 70cd258d command.test.ts/tunnel.test.ts, plus GitGui body/redirect bounds.
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import { fetchDescriptor, openTunnel } from "./transport.js";
import { runHostOperation } from "./runner.js";
import { collectProcessOutput, runLocalCommand } from "./command.js";
import { descriptor, environmentId, hostResponse } from "../testing/manager-fixture.js";
import { randomUUID } from "node:crypto";

const servers: Server[] = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function listen(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}
const target = { alias: "fixture-alias", hostname: "resolved.example", username: "alice", port: 2222, identityFile: "C:/my keys/id" };
const run = <A, E>(effect: Effect.Effect<A, E, any>) => Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)) as Effect.Effect<A, E>);
function processHandle(stdout: string, stderr = "", code = 0, kill = () => Effect.void) {
  return ChildProcessSpawner.makeHandle({ pid: ChildProcessSpawner.ProcessId(123), stdout: Stream.make(Buffer.from(stdout)), stderr: Stream.make(Buffer.from(stderr)), all: Stream.empty,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)), isRunning: Effect.succeed(false), kill, stdin: Sink.drain, getInputFd: () => Sink.drain, getOutputFd: () => Stream.empty, unref: Effect.succeed(Effect.void) });
}

describe("SSH transport and command scopes", () => {
  it("decodes a complete structured descriptor on the reserved loopback endpoint", async () => {
    const port = await listen((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(descriptor())); });
    expect((await run(fetchDescriptor(port))).environmentId).toBe(environmentId);
  });
  it.each(["headers", "body"])("bounds and aborts a real HTTP descriptor stalled at %s", async stage => {
    let closed!: () => void;
    const responseClosed = new Promise<void>(resolve => { closed = resolve; });
    const port = await listen((_req, response) => {
      response.once("close", closed);
      if (stage === "body") { response.writeHead(200, { "content-type": "application/json" }); response.write('{"environmentId":'); }
    });
    await expect(run(fetchDescriptor(port, 50))).rejects.toMatchObject({ category: "transport" });
    await responseClosed;
  });
  it("aborts a body during scope interruption, without waiting for the remote stream", async () => {
    const started = Deferred.makeUnsafe<void>();
    const port = await listen((_req, response) => { response.writeHead(200); response.write('{"environmentId":'); Deferred.doneUnsafe(started, Effect.void); });
    const abort = new AbortController();
    const pending = Effect.runPromise(fetchDescriptor(port, 60_000), { signal: abort.signal });
    const outcome = pending.then(() => false, () => true);
    await Effect.runPromise(Deferred.await(started)); abort.abort();
    expect(await outcome).toBe(true);
  });
  it("rejects descriptor redirects, oversized bodies, malformed schemas and incompatible versions", async () => {
    const destinations: string[] = [];
    const redirectTarget = await listen((req, response) => { destinations.push(req.url!); response.end(JSON.stringify(descriptor())); });
    const redirect = await listen((_req, response) => { response.writeHead(302, { location: `http://127.0.0.1:${redirectTarget}/secret` }); response.end(); });
    await expect(run(fetchDescriptor(redirect))).rejects.toMatchObject({ category: "transport" });
    expect(destinations).toEqual([]);
    for (const body of ["x".repeat(65537), '{"environmentId":"only-id"}', JSON.stringify({ ...descriptor(), protocolVersion: 99 })]) {
      const port = await listen((_req, response) => response.end(body));
      await expect(run(fetchDescriptor(port))).rejects.toMatchObject({ category: "unsupported" });
    }
  });
  it("bounds streams by bytes and stops reading immediately on excessive output", async () => {
    let pulled = 0;
    const stream = Stream.fromIterable([Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)]).pipe(Stream.tap(() => Effect.sync(() => { pulled++; })));
    await expect(Effect.runPromise(collectProcessOutput(stream, 10))).rejects.toThrow("SSH output exceeded");
    expect(pulled).toBe(2);
  });
  it("keeps ensure stdin open, sends one bounded JSON frame and preserves aliases/overrides", async () => {
    const request = { version: 1, acquisitionId: randomUUID(), locator: { kind: "default" as const }, expectedEnvironmentId: null, instanceId: null };
    let stdin = ""; let closedInput: boolean | undefined; let args: readonly string[] = [];
    const spawner = ChildProcessSpawner.make(command => Effect.gen(function* () {
      if (command._tag !== "StandardCommand") throw new Error("unexpected command");
      args = command.args;
      const input = command.options.stdin;
      if (typeof input === "object" && "stream" in input) { closedInput = input.endOnDone; stdin = yield* collectProcessOutput(input.stream); }
      return processHandle(JSON.stringify(hostResponse(request)) + "\n");
    }));
    const result = await run(runHostOperation(target, "ensure", request).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)));
    expect(result.acquisitionId).toBe(request.acquisitionId);
    expect(closedInput).toBe(false);
    expect(JSON.parse(stdin)).toEqual(request);
    expect(args).toContain("alice@fixture-alias");
    expect(args).toContain("C:/my keys/id"); expect(args).toContain("2222"); expect(args.at(-1)).toBe("gitgui-server ssh ensure --json");
    expect(args.join(" ")).not.toContain(request.acquisitionId);
    expect(args).toContain("StrictHostKeyChecking=yes");
  });
  it("reports tunnel auth/transport exit before readiness and kills the exact local child", async () => {
    let kills = 0;
    const spawner = ChildProcessSpawner.make(() => Effect.succeed(processHandle("", "Permission denied (publickey)", 255, () => Effect.sync(() => { kills++; }))));
    await expect(run(Effect.scoped(openTunnel(target, 3774)).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)))).rejects.toMatchObject({ category: "authentication" });
    expect(kills).toBe(1);
  });
  it("interrupts a real scoped child on timeout and leaves no owned process alive", async () => {
    let pid: number | undefined;
    const program = Effect.gen(function* () {
      const native = yield* ChildProcessSpawner.ChildProcessSpawner;
      const wrapped = ChildProcessSpawner.make(command => native.spawn(command).pipe(Effect.tap(child => Effect.sync(() => { pid = child.pid; }))));
      return yield* runLocalCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 100 }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, wrapped));
    });
    await expect(run(program)).rejects.toMatchObject({ category: "transport" });
    expect(pid).toBeDefined();
    expect(() => process.kill(pid!, 0)).toThrow();
  });
});
