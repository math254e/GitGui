/**
 * The GitGui RPC session over a fake WebSocket.
 *
 * These cover the session's own rules: the request lifecycle, the handshake
 * deadline, the difference between a blocked and a closed session, and the
 * event stream.
 */
import { EnvironmentId } from "@gitgui/contracts/environment";
import { CAPABILITY_RPC_CANCEL } from "@gitgui/contracts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as RpcSession from "./session.ts";
import { GitGuiClient } from "./promise.ts";
import { GitGuiRpcError } from "./protocol.ts";
import { ConnectionBlockedError, type PreparedConnection } from "../connection/model.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

const PREPARED_CONNECTION: PreparedConnection = {
  environmentId: ENVIRONMENT_ID,
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  socketUrl: "wss://environment.example.test/ws",
  httpAuthorization: null,
  target: {
    _tag: "PrimaryConnectionTarget",
    environmentId: ENVIRONMENT_ID,
    label: "Test environment",
    httpBaseUrl: "https://environment.example.test",
    wsBaseUrl: "wss://environment.example.test",
  },
};

class FakeWebSocket implements Socket.WebSocketLike {
  readyState = 1;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<(event: Socket.WebSocketEvent) => void>>();

  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: Socket.WebSocketEvent) => void,
  ): void {
    const existing = this.listeners.get(type) ?? new Set();
    existing.add(listener);
    this.listeners.set(type, existing);
  }

  removeEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: Socket.WebSocketEvent) => void,
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.emit("close", { code, reason });
  }

  send(data: string | Uint8Array): void {
    const raw = typeof data === "string" ? data : new TextDecoder().decode(data);
    this.sent.push(raw);
    // The fake server answers the two methods the session itself uses.
    const request = JSON.parse(raw) as { id: string; method: string };
    if (request.method === "server.get_info") {
      queueMicrotask(() =>
        this.deliver({
          type: "response",
          id: request.id,
          ok: true,
          result: {
            server_id: ENVIRONMENT_ID,
            environment_id: ENVIRONMENT_ID,
            protocol_version: 2,
            server_version: "0.0.0-test",
            bind_address: "127.0.0.1:3774",
            capabilities: [],
          },
        }),
      );
    }
    if (request.method === "server.get_status") {
      queueMicrotask(() =>
        this.deliver({
          type: "response",
          id: request.id,
          ok: true,
          result: {
            lifecycle: "ready",
            ready: true,
            server_id: ENVIRONMENT_ID,
            environment_id: ENVIRONMENT_ID,
            protocol_version: 2,
            uptime_seconds: 1,
          },
        }),
      );
    }
  }

  emit(type: "open" | "message" | "error" | "close", event: Socket.WebSocketEvent): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  /** Delivers one server message. */
  deliver(message: unknown): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  /** The requests the client sent, in order. */
  requests(): ReadonlyArray<{ id: string; method: string; params: unknown }> {
    return this.sent.map((raw) => JSON.parse(raw) as { id: string; method: string; params: unknown });
  }

  /** The requests for one method, in order. */
  requestsFor(method: string): ReadonlyArray<{ id: string; method: string; params: unknown }> {
    return this.requests().filter((request) => request.method === method);
  }
}

const makeSession = Effect.fn("TestRpcSession.make")(function* (options?: {
  readonly socket?: FakeWebSocket;
  readonly requestTimeout?: Duration.Input;
  readonly welcomeTimeout?: Duration.Input;
}) {
  const socket = options?.socket ?? new FakeWebSocket();
  const layer = Layer.provideMerge(
    RpcSession.layer({
      requestTimeout: options?.requestTimeout ?? "30 seconds",
      welcomeTimeout: options?.welcomeTimeout ?? "15 seconds",
    }),
    Layer.succeed(Socket.WebSocketConstructor, () => socket as Socket.WebSocketLike),
  );
  // The session lives in the caller's scope, so the socket and the reader
  // stay open for the whole test.
  const session = yield* Effect.gen(function* () {
    const factory = yield* RpcSession.RpcSessionFactory;
    return yield* factory.connect(PREPARED_CONNECTION);
  }).pipe(Effect.provide(layer));
  return { socket, session };
});

/** Waits until the fake server has seen what the test is waiting for. */
const waitFor = (predicate: () => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (predicate()) return;
      yield* Effect.yieldNow;
    }
    throw new Error("The fake socket did not reach the expected state.");
  });

const welcome = (protocolVersion = 2) => ({
  type: "welcome",
  server_id: ENVIRONMENT_ID,
  environment_id: ENVIRONMENT_ID,
  protocol_version: protocolVersion,
  capabilities: [],
});

describe("the GitGui RPC session", () => {
  it.effect("records bounded, content-free measurements for file view RPCs", () =>
    Effect.gen(function* () {
      const { socket, session } = yield* makeSession();
      const diagnostic = vi.spyOn(console, "debug").mockImplementation(() => undefined);
      try {
        socket.deliver(welcome());
        yield* session.ready;

        const call = Effect.runPromise(session.client.call("git.working_tree_file_diff", {
          repositoryId: "repository-1",
          filePath: "private/source.ts",
          staged: false,
        }));
        yield* waitFor(() => socket.requestsFor("git.working_tree_file_diff").length > 0);
        const request = socket.requestsFor("git.working_tree_file_diff")[0];
        socket.deliver({
          type: "response",
          id: request.id,
          ok: true,
          result: { diff: { originalContent: "must not be logged", modifiedContent: "also private" } },
        });
        yield* Effect.promise(() => call);

        const entry = diagnostic.mock.calls.find(([label]) => label === "[GitGui RPC diagnostic]");
        expect(entry).toBeDefined();
        expect(JSON.stringify(entry)).not.toContain("private/source.ts");
        expect(JSON.stringify(entry)).not.toContain("must not be logged");
        expect(entry?.[1]).toMatchObject({ method: "git.working_tree_file_diff", ok: true });
        expect((entry?.[1] as { responseBytes: number }).responseBytes).toBeGreaterThan(0);
      } finally {
        diagnostic.mockRestore();
      }
    }).pipe(Effect.scoped),
  );

  it.effect("records timing and response size when a measured RPC fails", () =>
    Effect.gen(function* () {
      const { socket, session } = yield* makeSession();
      const diagnostic = vi.spyOn(console, "debug").mockImplementation(() => undefined);
      try {
        socket.deliver(welcome());
        yield* session.ready;

        const call = Effect.runPromise(session.client.call("git.hunk_preview", {
          repositoryId: "repository-1",
          filePath: "private/source.ts",
          staged: false,
        }));
        yield* waitFor(() => socket.requestsFor("git.hunk_preview").length > 0);
        const request = socket.requestsFor("git.hunk_preview")[0];
        socket.deliver({
          type: "response",
          id: request.id,
          ok: false,
          error: { code: "repository_error", message: "safe error" },
        });
        const failure = yield* Effect.promise(() => call.catch((error: unknown) => error));

        const entry = diagnostic.mock.calls.find(([label]) => label === "[GitGui RPC diagnostic]");
        expect(failure).toBeInstanceOf(GitGuiRpcError);
        expect(entry?.[1]).toMatchObject({ method: "git.hunk_preview", ok: false });
        expect((entry?.[1] as { responseBytes: number }).responseBytes).toBeGreaterThan(0);
        expect(JSON.stringify(entry)).not.toContain("private/source.ts");
      } finally {
        diagnostic.mockRestore();
      }
    }).pipe(Effect.scoped),
  );

  it.effect("correlates out-of-order concurrent successes and errors", () =>
    Effect.gen(function* () {
      const { socket, session } = yield* makeSession();
      socket.deliver(welcome());
      yield* session.ready;
      const first = yield* Effect.forkChild(session.client.call("repositories.list", {}));
      const second = yield* Effect.forkChild(session.client.call("git.status", { repositoryId: "repo" }));
      yield* waitFor(() => socket.requestsFor("git.status").length === 1);
      const a = socket.requestsFor("repositories.list")[0]!;
      const b = socket.requestsFor("git.status")[0]!;
      socket.deliver({ type: "response", id: b.id, ok: false, error: { code: "forbidden", message: "Denied", details: { requiredScope: "repository:read" } } });
      const failure = yield* Fiber.join(second).pipe(Effect.flip);
      expect(failure.requestId).toBe(b.id);
      expect(failure.code).toBe("forbidden");
      expect(failure.details).toEqual({ requiredScope: "repository:read" });
      expect(yield* session.pendingRequests).toBe(1);
      socket.deliver({ type: "response", id: a.id, ok: true, result: { repositories: [] } });
      expect((yield* Fiber.join(first)).repositories).toEqual([]);
      expect(yield* session.pendingRequests).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("cancels timed-out requests and ignores their late responses", () =>
    Effect.gen(function* () {
      const { socket, session } = yield* makeSession({ requestTimeout: "5 seconds" });
      socket.deliver({ ...welcome(), capabilities: [CAPABILITY_RPC_CANCEL] });
      yield* session.ready;
      const first = yield* Effect.forkChild(session.client.call("repositories.list", {}));
      yield* waitFor(() => socket.requestsFor("repositories.list").length === 1);
      const id = socket.requestsFor("repositories.list")[0]!.id;
      yield* TestClock.adjust("6 seconds");
      expect((yield* Fiber.join(first).pipe(Effect.flip)).code).toBe("request_timeout");
      expect(socket.sent.map((raw) => JSON.parse(raw)).filter((frame) => frame.type === "cancel")).toEqual([{ type: "cancel", id }]);
      socket.deliver({ type: "response", id, ok: true, result: { repositories: ["obsolete"] } });
      const second = yield* Effect.forkChild(session.client.call("repositories.list", {}));
      yield* waitFor(() => socket.requestsFor("repositories.list").length === 2);
      socket.deliver({ type: "response", id: socket.requestsFor("repositories.list")[1]!.id, ok: true, result: { repositories: [] } });
      expect((yield* Fiber.join(second)).repositories).toEqual([]);
      expect(yield* session.pendingRequests).toBe(0);
    }).pipe(Effect.provide(TestClock.layer()), Effect.scoped),
  );

  it.effect("aborts obsolete file contents and hunk previews through the Promise bridge", () =>
    Effect.gen(function* () {
      const { socket, session } = yield* makeSession();
      socket.deliver({ ...welcome(), capabilities: [CAPABILITY_RPC_CANCEL] });
      yield* session.ready;
      const client = new GitGuiClient({ client: session.client, welcome: yield* session.welcome });
      const controller = new AbortController();
      const old = [
        client.getWorkingTreeFileDiff({ repositoryId: "repo", filePath: "old.txt", staged: false }, controller.signal),
        client.getHunkPreview({ repositoryId: "repo", filePath: "old.txt", staged: false }, controller.signal),
        client.getCommitWorkingTreeFileDiff({ repositoryId: "repo", commitHash: "a".repeat(40), filePath: "old.txt" }, controller.signal),
      ].map((request) => request.catch((error: unknown) => error));
      yield* waitFor(() => socket.requestsFor("git.commit_working_tree_file_diff").length === 1);
      controller.abort();
      const errors = yield* Effect.promise(() => Promise.all(old));
      expect(errors).toHaveLength(3);
      for (const error of errors) expect(error).toEqual(expect.objectContaining({ code: "request_cancelled" }));
      expect(yield* session.pendingRequests).toBe(0);
      expect(socket.sent.filter((raw) => JSON.parse(raw).type === "cancel")).toHaveLength(3);
      const before = socket.sent.length;
      const aborted = yield* Effect.promise(() => client.getCommitFileDiff({
        repositoryId: "repo", commitHash: "a".repeat(40), filePath: "aborted.txt",
      }, controller.signal).catch((error: unknown) => error));
      expect(aborted).toEqual(expect.objectContaining({ code: "request_cancelled" }));
      expect(socket.sent).toHaveLength(before);
      const selected = client.getCommitFileDiff({ repositoryId: "repo", commitHash: "a".repeat(40), filePath: "selected.txt" });
      yield* waitFor(() => socket.requestsFor("git.commit_file_diff").length === 1);
      for (const method of ["git.working_tree_file_diff", "git.hunk_preview", "git.commit_working_tree_file_diff"]) {
        socket.deliver({ type: "response", id: socket.requestsFor(method)[0]!.id, ok: true, result: { diff: "obsolete" } });
      }
      socket.deliver({ type: "response", id: socket.requestsFor("git.commit_file_diff")[0]!.id, ok: true, result: { diff: "selected" } });
      expect(yield* Effect.promise(() => selected)).toEqual({ diff: "selected" });
      client.dispose();
    }).pipe(Effect.scoped),
  );

  it.effect("fails every concurrent pending request on disconnect without sending cancellations", () =>
    Effect.gen(function* () {
      const { socket, session } = yield* makeSession();
      socket.deliver({ ...welcome(), capabilities: [CAPABILITY_RPC_CANCEL] });
      yield* session.ready;
      const requests = [];
      for (let n = 0; n < 12; n++) requests.push(yield* Effect.forkChild(session.client.call("repositories.list", {})));
      yield* waitFor(() => socket.requestsFor("repositories.list").length === 12);
      socket.close(1006, "Disconnected");
      for (const request of requests) expect((yield* Fiber.join(request).pipe(Effect.flip)).code).toBe("disconnected");
      expect(yield* session.pendingRequests).toBe(0);
      expect(socket.sent.filter((raw) => JSON.parse(raw).type === "cancel")).toHaveLength(0);
    }).pipe(Effect.scoped),
  );
  it.effect("greets the server and becomes ready", () =>
    Effect.gen(function* () {
      const { socket, session } = yield* makeSession();
      socket.deliver(welcome());
      yield* session.ready;
      expect(yield* session.pendingRequests).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("removes a pending request when it times out", () =>
    Effect.gen(function* () {
      const { socket, session } = yield* makeSession({ requestTimeout: "5 seconds" });
      socket.deliver(welcome());
      yield* session.ready;

      const request = yield* Effect.forkChild(session.client.call("repositories.list", {}));
      yield* waitFor(() => socket.requestsFor("repositories.list").length > 0);
      expect(yield* session.pendingRequests).toBe(1);

      yield* TestClock.adjust("6 seconds");
      const error = yield* Fiber.join(request).pipe(Effect.flip);
      expect((error as GitGuiRpcError).code).toBe("request_timeout");
      expect(yield* session.pendingRequests).toBe(0);
    }).pipe(Effect.provide(TestClock.layer()), Effect.scoped),
  );

  it.effect("removes a pending request when the caller is interrupted", () =>
    Effect.gen(function* () {
      const { socket, session } = yield* makeSession();
      socket.deliver(welcome());
      yield* session.ready;

      const fiber = yield* Effect.forkChild(session.client.call("repositories.list", {}));
      yield* Effect.yieldNow;
      expect(yield* session.pendingRequests).toBe(1);

      yield* Fiber.interrupt(fiber);
      expect(yield* session.pendingRequests).toBe(0);
      expect(socket.sent.filter((raw) => JSON.parse(raw).type === "cancel")).toHaveLength(0);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a new request once the session is closing", () =>
    Effect.gen(function* () {
      const { socket, session } = yield* makeSession();
      socket.deliver(welcome());
      yield* session.ready;

      socket.close(1006, "The server went away.");
      yield* session.closed.pipe(Effect.flip);
      const error = yield* session.client.call("repositories.list", {}).pipe(Effect.flip);
      expect((error as GitGuiRpcError).code).toBe("session_closed");
    }).pipe(Effect.scoped),
  );

  it.effect("fails the handshake when the server never greets", () =>
    Effect.gen(function* () {
      const { session } = yield* makeSession({ welcomeTimeout: "5 seconds" });
      const handshake = yield* Effect.forkChild(session.welcome);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("6 seconds");
      const error = yield* Fiber.join(handshake).pipe(Effect.flip);
      expect(error._tag).toBe("ConnectionTransientError");
      expect(error.reason).toBe("timeout");
    }).pipe(Effect.provide(TestClock.layer()), Effect.scoped),
  );

  it.effect("keeps a blocked session blocked when the socket closes", () =>
    Effect.gen(function* () {
      const { socket, session } = yield* makeSession();
      socket.deliver(welcome(99));

      const welcomeError = yield* session.welcome.pipe(Effect.flip);
      expect(welcomeError).toBeInstanceOf(ConnectionBlockedError);
      expect((welcomeError as ConnectionBlockedError).reason).toBe("unsupported");

      socket.close(1006, "The server went away.");
      const closedError = yield* session.closed.pipe(Effect.flip);
      expect(closedError).toBeInstanceOf(ConnectionBlockedError);
      expect((closedError as ConnectionBlockedError).reason).toBe("unsupported");
    }).pipe(Effect.scoped),
  );

  it.effect("reports a closed session as transient", () =>
    Effect.gen(function* () {
      const { socket, session } = yield* makeSession();
      socket.deliver(welcome());
      yield* session.ready;

      socket.close(1006, "The server went away.");
      const error = yield* session.closed.pipe(Effect.flip);
      expect(error._tag).toBe("ConnectionTransientError");
    }).pipe(Effect.scoped),
  );

  it.effect("delivers every event in order", () =>
    Effect.gen(function* () {
      const { socket, session } = yield* makeSession();
      socket.deliver(welcome());
      yield* session.ready;

      const received: number[] = [];
      const collector = yield* Effect.forkChild(
        Stream.runForEach(session.client.events, (event) =>
          Effect.sync(() => {
            received.push(event.sequence);
          }),
        ),
      );
      yield* Effect.yieldNow;

      for (let sequence = 1; sequence <= 100; sequence += 1) {
        socket.deliver({ type: "event", sequence, event: "repository.changed", payload: {} });
      }
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(collector);

      expect(received).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
    }).pipe(Effect.scoped),
  );

  it.effect("broadcasts events and gaps to independent consumers and releases disposed promise readers", () =>
    Effect.gen(function* () {
      const { socket, session } = yield* makeSession();
      socket.deliver(welcome());
      yield* session.ready;
      const a: number[] = [];
      const b: number[] = [];
      const gapsA: RpcSession.SequenceGap[] = [];
      const gapsB: RpcSession.SequenceGap[] = [];
      const readers = yield* Effect.all([
        Stream.runForEach(session.client.events, (event) => Effect.sync(() => a.push(event.sequence))),
        Stream.runForEach(session.client.events, (event) => Effect.sync(() => b.push(event.sequence))),
        Stream.runForEach(session.sequenceGaps, (gap) => Effect.sync(() => gapsA.push(gap))),
        Stream.runForEach(session.sequenceGaps, (gap) => Effect.sync(() => gapsB.push(gap))),
      ].map((effect) => Effect.forkChild(effect)));
      const client = new GitGuiClient({ client: session.client, welcome: yield* session.welcome });
      const promiseEvents: number[] = [];
      client.on("repository.changed", (event) => promiseEvents.push(event.sequence));
      yield* Effect.yieldNow;
      socket.deliver({ type: "event", sequence: 1, event: "repository.changed", payload: {} });
      yield* Effect.yieldNow;
      client.dispose();
      yield* Effect.yieldNow;
      const replacement = new GitGuiClient({ client: session.client, welcome: yield* session.welcome });
      const replacementEvents: number[] = [];
      replacement.on("repository.changed", (event) => replacementEvents.push(event.sequence));
      yield* Effect.yieldNow;
      socket.deliver({ type: "event", sequence: 3, event: "repository.changed", payload: {} });
      socket.deliver({ type: "event", sequence: 4, event: "repository.changed", payload: {} });
      yield* Effect.yieldNow;
      expect(a).toEqual([1, 3, 4]);
      expect(b).toEqual(a);
      expect(gapsA).toEqual([{ expected: 2, received: 3 }]);
      expect(gapsB).toEqual(gapsA);
      expect(promiseEvents).toEqual([1]);
      expect(replacementEvents).toEqual([3, 4]);
      replacement.dispose();
      for (const reader of readers) yield* Fiber.interrupt(reader);
    }).pipe(Effect.scoped),
  );

  it.effect("reports a hole in the event sequence", () =>
    Effect.gen(function* () {
      const { socket, session } = yield* makeSession();
      socket.deliver(welcome());
      yield* session.ready;

      const gaps: RpcSession.SequenceGap[] = [];
      const collector = yield* Effect.forkChild(
        Stream.runForEach(session.sequenceGaps, (gap) => Effect.sync(() => gaps.push(gap))),
      );
      yield* Effect.yieldNow;

      socket.deliver({ type: "event", sequence: 1, event: "repository.changed", payload: {} });
      socket.deliver({ type: "event", sequence: 3, event: "repository.changed", payload: {} });
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(collector);

      expect(gaps).toEqual([{ expected: 2, received: 3 }]);
    }).pipe(Effect.scoped),
  );

  it.effect("answers a request with the server's response", () =>
    Effect.gen(function* () {
      const { socket, session } = yield* makeSession();
      socket.deliver(welcome());
      yield* session.ready;

      const response = yield* Effect.forkChild(session.client.call("repositories.list", {}));
      yield* waitFor(() => socket.requestsFor("repositories.list").length > 0);

      const [request] = socket.requestsFor("repositories.list");
      socket.deliver({ type: "response", id: request!.id, ok: true, result: { repositories: [] } });

      const result = yield* Fiber.join(response);
      expect(result.repositories).toEqual([]);
      expect(yield* session.pendingRequests).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("fails a request with the server's error", () =>
    Effect.gen(function* () {
      const { socket, session } = yield* makeSession();
      socket.deliver(welcome());
      yield* session.ready;

      const response = yield* Effect.forkChild(session.client.call("repositories.list", {}));
      yield* waitFor(() => socket.requestsFor("repositories.list").length > 0);

      const [request] = socket.requestsFor("repositories.list");
      socket.deliver({
        type: "response",
        id: request!.id,
        ok: false,
        error: { code: "forbidden", message: "The session lacks the scope." },
      });

      const error = yield* Fiber.join(response).pipe(Effect.flip);
      expect((error as GitGuiRpcError).code).toBe("forbidden");
      expect((error as GitGuiRpcError).message).toBe("The session lacks the scope.");
    }).pipe(Effect.scoped),
  );
});
