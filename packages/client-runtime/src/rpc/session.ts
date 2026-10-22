/**
 * Vendored from T3 Code (`packages/client-runtime/src/rpc/session.ts`).
 *
 * Upstream: t3code @ 1688f965682d331da16a8c39f049592361f69c8d
 * (`v0.1.2-nightly.20261021.3473`).
 *
 * Divergences from upstream:
 * - Each event/gap consumer acquires its own scoped PubSub subscription.
 * - T3 Code's server speaks `effect/rpc`, so the session is built from
 *   `RpcClient.Protocol` and `RpcSerialization.layerJson`. The GitGui server
 *   is Rust and speaks the GitGui JSON envelope, so the session multiplexes
 *   requests, responses, and events over `effect/socket` directly.
 * - T3 Code waits for an initial server configuration stream before the
 *   session is ready. GitGui has no configuration stream, so the session waits
 *   for the server welcome and one `server.get_info` call.
 * - The welcome has its own deadline. Opening the socket and completing the
 *   application handshake are separate stages, and a server that accepts the
 *   socket but never greets must not hang the connection.
 * - Every request removes its pending entry on every exit, including a
 *   timeout, an interruption, and a failed write, and a closing session
 *   refuses new requests. Registration and cleanup are uninterruptible.
 * - Abandoned requests send a capability-gated cancellation notification,
 *   translating Effect RPC interruption to the Rust envelope. The server
 *   enforces read-only cancellation.
 * - A blocked session stays blocked. A later socket close does not turn a
 *   deliberate rejection into a transient failure.
 * - The event stream is lossless and ordered, and the server's monotonic event
 *   sequence is watched, so a missing event is detected instead of silently
 *   leaving the client with a hole.
 */
import type { OrderedEventEnvelope, ServerInfo, WelcomeMessage } from "@gitgui/contracts";
import { CAPABILITY_RPC_CANCEL, type CancelRequest } from "@gitgui/contracts";
import { PROTOCOL_VERSION } from "@gitgui/contracts/environment";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";

import {
  ConnectionBlockedError,
  ConnectionTransientError,
  type ConnectionAttemptError,
  type PreparedConnection,
} from "../connection/model.ts";
import {
  GitGuiRpcError,
  type GitGuiRpcMethod,
  type GitGuiRpcMethods,
  type GitGuiRpcProtocolClient,
} from "./protocol.ts";

const SOCKET_OPEN_TIMEOUT = "15 seconds";
/** The server must greet the client after the socket opens. */
const WELCOME_TIMEOUT = "15 seconds";
const REQUEST_TIMEOUT = "30 seconds";

/** A hole in the server's event sequence. */
export interface SequenceGap {
  readonly expected: number;
  readonly received: number;
}

export interface RpcSession {
  readonly client: GitGuiRpcProtocolClient;
  readonly welcome: Effect.Effect<WelcomeMessage, ConnectionAttemptError>;
  readonly initialConfig: Effect.Effect<ServerInfo, ConnectionAttemptError>;
  readonly ready: Effect.Effect<void, ConnectionAttemptError>;
  readonly probe: Effect.Effect<void, ConnectionAttemptError>;
  readonly closed: Effect.Effect<never, ConnectionAttemptError>;
  /**
   * The requests that are still waiting for a response.
   *
   * A request is removed on every exit, so this returns to zero once the
   * session is idle.
   */
  readonly pendingRequests: Effect.Effect<number>;
  /**
   * Holes in the server's event sequence.
   *
   * The server numbers its events monotonically, so a hole means an event was
   * missed and the consumer's view is no longer contiguous.
   */
  readonly sequenceGaps: Stream.Stream<SequenceGap, GitGuiRpcError>;
}

export interface RpcSessionOptions {
  /** How long one request waits for its response. */
  readonly requestTimeout?: Duration.Input;
  /** How long the server has to send its welcome. */
  readonly welcomeTimeout?: Duration.Input;
}

export class RpcSessionFactory extends Context.Service<
  RpcSessionFactory,
  {
    readonly connect: (
      connection: PreparedConnection,
    ) => Effect.Effect<RpcSession, ConnectionAttemptError, Scope.Scope>;
  }
>()("@gitgui/client-runtime/rpc/session/RpcSessionFactory") {}

interface PendingRequest {
  readonly deferred: Deferred.Deferred<unknown, GitGuiRpcError>;
  readonly method: GitGuiRpcMethod;
  readonly startedAt: number;
  readonly inFlightBeforeSend: number;
  writeStartedAt?: number;
  sentAt?: number;
}

const measuredMethods = new Set<GitGuiRpcMethod>([
  "git.commit_file_diff",
  "git.working_tree_file_diff",
  "git.hunk_preview",
  "git.apply_hunks",
  "git.stage",
  "git.unstage",
  "repositories.refresh",
]);

const monotonicNow = () => globalThis.performance?.now?.() ?? Date.now();
const utf8ByteLength = (text: string) => {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
    if (bytes >= 0x7fffffff) return 0x7fffffff;
  }
  return bytes;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.fn("RpcSessionFactory.make")(function* (
  options: RpcSessionOptions = {},
) {
  const requestTimeout = options.requestTimeout ?? REQUEST_TIMEOUT;
  const welcomeTimeout = options.welcomeTimeout ?? WELCOME_TIMEOUT;
  const webSocketConstructor = yield* Socket.WebSocketConstructor;

  const connect = Effect.fnUntraced(function* (
    connection: PreparedConnection,
  ): Effect.fn.Return<RpcSession, ConnectionAttemptError, Scope.Scope> {
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": connection.environmentId,
    });

    const socketLayer = Socket.layerWebSocket(connection.socketUrl, {
      openTimeout: SOCKET_OPEN_TIMEOUT,
    });
    const socketContext = yield* Layer.build(
      socketLayer.pipe(
        Layer.provide(Layer.succeed(Socket.WebSocketConstructor, webSocketConstructor)),
      ),
    ).pipe(
      Effect.mapError(
        () =>
          new ConnectionTransientError({
            reason: "transport",
            detail: `${connection.label} could not establish a WebSocket connection.`,
          }),
      ),
    );
    const socket = Context.get(socketContext, Socket.Socket);
    const reader = yield* socket.reader.pipe(
      Effect.mapError(
        () =>
          new ConnectionTransientError({
            reason: "transport",
            detail: `${connection.label} could not open its WebSocket stream.`,
          }),
      ),
    );
    const writer = yield* socket.writer;

    const welcome = yield* Deferred.make<WelcomeMessage, ConnectionBlockedError>();
    /** The reason the session ended. The first reason wins. */
    const terminated = yield* Deferred.make<never, ConnectionAttemptError>();
    /** Set once the session starts closing, so no new request is accepted. */
    const closing = yield* Ref.make(false);
    const pending = yield* Ref.make<ReadonlyMap<string, PendingRequest>>(new Map());
    const lastSequence = yield* Ref.make<number | undefined>(undefined);
    // An unbounded, non-blocking publication: the reader never waits for a
    // slow consumer, so a slow subscriber cannot delay an RPC response.
    const events = yield* PubSub.unbounded<OrderedEventEnvelope>();
    const gaps = yield* PubSub.unbounded<SequenceGap>();
    yield* Effect.addFinalizer(() => Effect.all([
      PubSub.shutdown(events), PubSub.shutdown(gaps),
    ], { discard: true }));
    let requestCounter = 0;
    let supportsCancellation = false;

    /**
     * Ends the session once, with the first reason that arrives.
     *
     * A deliberate block is not overwritten by the socket close that follows
     * it, so the supervisor keeps the environment blocked instead of retrying
     * it as a transient failure.
     */
    const terminate = (error: ConnectionAttemptError) =>
      Effect.gen(function* () {
        yield* Ref.set(closing, true);
        const completed = yield* Deferred.fail(terminated, error);
        if (completed) {
          yield* Effect.logDebug("The GitGui RPC session ended.", {
            reason: error._tag,
            detail: error.detail,
          });
        }
        yield* Ref.get(pending).pipe(
          Effect.flatMap((current) =>
            Effect.forEach(
              [...current.values()],
              (entry) => Deferred.fail(entry.deferred, new GitGuiRpcError({
                code: "disconnected",
                message: error.detail,
              })),
              { discard: true, concurrency: "unbounded" },
            ),
          ),
        );
        yield* Ref.set(pending, new Map());
      });

    const failPending = (error: GitGuiRpcError) =>
      Ref.get(pending).pipe(
        Effect.flatMap((current) =>
          Effect.forEach(
            [...current.values()],
            (entry) => Deferred.fail(entry.deferred, error),
            { discard: true, concurrency: "unbounded" },
          ),
        ),
        Effect.andThen(Ref.set(pending, new Map())),
      );

    /** Records the event and watches the server's sequence for holes. */
    const publishEvent = (event: OrderedEventEnvelope) =>
      Effect.gen(function* () {
        const previous = yield* Ref.get(lastSequence);
        if (previous !== undefined && event.sequence > previous + 1) {
          yield* PubSub.publish(gaps, {
            expected: previous + 1,
            received: event.sequence,
          });
        }
        yield* Ref.set(lastSequence, Math.max(previous ?? 0, event.sequence));
        yield* PubSub.publish(events, event);
      });

    const handleFrame = (text: string) =>
      Effect.gen(function* () {
        const message = yield* Effect.try({
          try: () => JSON.parse(text) as unknown,
          catch: (cause) =>
            new GitGuiRpcError({
              code: "invalid_frame",
              message: "GitGui sent invalid JSON.",
              details: String(cause),
            }),
        });
        if (!isRecord(message)) {
          return yield* Effect.fail(
            new GitGuiRpcError({ code: "invalid_frame", message: "GitGui sent an unknown message." }),
          );
        }
        const type = message["type"];
        if (type === "welcome") {
          const payload = message as unknown as WelcomeMessage;
          supportsCancellation = payload.capabilities.includes(CAPABILITY_RPC_CANCEL);
          if (payload.environment_id !== connection.environmentId) {
            const blocked = new ConnectionBlockedError({
              reason: "configuration",
              detail: `Connected environment ${payload.environment_id} does not match ${connection.environmentId}.`,
            });
            yield* terminate(blocked);
            return yield* Deferred.fail(welcome, blocked);
          }
          if (payload.protocol_version !== PROTOCOL_VERSION) {
            const blocked = new ConnectionBlockedError({
              reason: "unsupported",
              detail: `GitGui protocol version ${payload.protocol_version} is incompatible with ${PROTOCOL_VERSION}.`,
            });
            yield* terminate(blocked);
            return yield* Deferred.fail(welcome, blocked);
          }
          return yield* Deferred.succeed(welcome, payload);
        }
        if (type === "response") {
          const id = message["id"];
          if (typeof id !== "string") {
            return yield* Effect.fail(
              new GitGuiRpcError({ code: "invalid_response", message: "GitGui sent a response without an id." }),
            );
          }
          const entry = (yield* Ref.get(pending)).get(id);
          if (entry === undefined) {
            return yield* Effect.void;
          }
          if (measuredMethods.has(entry.method)) {
            const receivedAt = monotonicNow();
            const responseBytes = utf8ByteLength(text);
            console.debug("[GitGui RPC diagnostic]", {
              method: entry.method,
              writerWaitMs: Math.max(0, (entry.sentAt ?? receivedAt) - (entry.writeStartedAt ?? entry.startedAt)),
              roundTripMs: Math.max(0, receivedAt - entry.startedAt),
              responseBytes,
              inFlightBeforeSend: entry.inFlightBeforeSend,
              ok: message["ok"] === true,
            });
          }
          yield* Ref.update(pending, (current) => {
            const next = new Map(current);
            next.delete(id);
            return next;
          });
          if (message["ok"] === true) {
            return yield* Deferred.succeed(entry.deferred, message["result"]);
          }
          const error = message["error"];
          const details = isRecord(error) ? error : {};
          return yield* Deferred.fail(
            entry.deferred,
            new GitGuiRpcError({
              code: typeof details["code"] === "string" ? details["code"] : "protocol_error",
              message:
                typeof details["message"] === "string"
                  ? details["message"]
                  : "The GitGui server rejected the request.",
              requestId: id,
              ...(details["details"] === undefined ? {} : { details: details["details"] }),
            }),
          );
        }
        if (type === "event") {
          return yield* publishEvent(message as unknown as OrderedEventEnvelope);
        }
        if (type === "protocol_error") {
          const error = message["error"];
          const details = isRecord(error) ? error : {};
          const failure = new GitGuiRpcError({
            code: typeof details["code"] === "string" ? details["code"] : "protocol_error",
            message:
              typeof details["message"] === "string"
                ? details["message"]
                : "The GitGui server rejected the session.",
          });
          yield* failPending(failure);
          const blocked = new ConnectionBlockedError({
            reason: "authentication",
            detail: failure.message,
          });
          yield* terminate(blocked);
          return yield* Deferred.fail(welcome, blocked);
        }
        return yield* Effect.fail(
          new GitGuiRpcError({ code: "unknown_message", message: "GitGui sent an unknown protocol message." }),
        );
      });

    const readLoop = Effect.gen(function* () {
      const decoder = new TextDecoder();
      for (;;) {
        const chunks = yield* reader.pull;
        for (const chunk of chunks) {
          const text = typeof chunk === "string" ? chunk : decoder.decode(chunk);
          yield* handleFrame(text);
        }
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          Effect.logDebug("The GitGui RPC reader ended.", { cause });
        }),
      ),
      // The reader always reports the end of the session, however it ended.
      Effect.ensuring(
        terminate(
          new ConnectionTransientError({
            reason: "transport",
            detail: `${connection.label} disconnected.`,
          }),
        ),
      ),
      Effect.forkScoped,
    );
    yield* readLoop;

    const call = <K extends GitGuiRpcMethod>(
      method: K,
      input: GitGuiRpcMethods[K]["input"],
    ): Effect.Effect<GitGuiRpcMethods[K]["output"], GitGuiRpcError> =>
      Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
        if (yield* Ref.get(closing)) {
          return yield* new GitGuiRpcError({
            code: "session_closed",
            message: `The GitGui session for ${method} is closing.`,
          });
        }
        requestCounter += 1;
        const id = `request-${requestCounter}`;
        const startedAt = monotonicNow();
        const inFlightBeforeSend = (yield* Ref.get(pending)).size;
        const deferred = yield* Deferred.make<unknown, GitGuiRpcError>();
        yield* Ref.update(pending, (current) => {
          const next = new Map(current);
          next.set(id, { deferred, method, startedAt, inFlightBeforeSend });
          return next;
        });
        // The entry is removed on every exit: a response, a rejection, a
        // timeout, an interruption, or a failed write. Mask registration so
        // interruption cannot land before this cleanup is installed.
        const result = yield* Effect.ensuring(
          restore(Effect.gen(function* () {
            const writeStartedAt = monotonicNow();
            const entryBeforeWrite = (yield* Ref.get(pending)).get(id);
            if (entryBeforeWrite) entryBeforeWrite.writeStartedAt = writeStartedAt;
            yield* writer
              .write(JSON.stringify({ id, method, params: input }))
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new GitGuiRpcError({
                      code: "transport",
                      message: `Unable to send the ${method} request to GitGui.`,
                      requestId: id,
                      details: String(cause),
                    }),
                ),
              );
            const entry = (yield* Ref.get(pending)).get(id);
            if (entry) entry.sentAt = monotonicNow();
            return yield* Deferred.await(deferred).pipe(
              Effect.timeoutOption(requestTimeout),
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    Effect.fail(
                      new GitGuiRpcError({
                        code: "request_timeout",
                        message: `GitGui request timed out: ${method}`,
                        requestId: id,
                      }),
                    ),
                  onSome: Effect.succeed,
                }),
              ),
            );
          })),
          Effect.gen(function* () {
            const abandoned = yield* Ref.modify(pending, (current) => {
              const next = new Map(current);
              next.delete(id);
              return [current.has(id), next] as const;
            });
            if (abandoned && supportsCancellation && !(yield* Ref.get(closing))) {
              const notification: CancelRequest = { type: "cancel", id };
              yield* writer.write(JSON.stringify(notification)).pipe(Effect.ignore);
            }
          }),
        );
        return result as GitGuiRpcMethods[K]["output"];
      }));

    const client: GitGuiRpcProtocolClient = {
      call,
      events: Stream.unwrap(Effect.map(PubSub.subscribe(events), Stream.fromSubscription)),
    };

    const welcomeEffect = Deferred.await(welcome).pipe(
      Effect.timeoutOption(welcomeTimeout),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new ConnectionTransientError({
                reason: "timeout",
                detail: `${connection.label} did not send a welcome message.`,
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

    const initialConfig = welcomeEffect.pipe(
      Effect.flatMap(() =>
        call("server.get_info", {}).pipe(
          Effect.mapError(
            (error) =>
              new ConnectionTransientError({
                reason: "remote-unavailable",
                detail: `${connection.label} could not describe itself: ${error.message}`,
              }),
          ),
        ),
      ),
    );

    const probe = welcomeEffect.pipe(
      Effect.flatMap(() => call("server.get_status", {})),
      Effect.mapError(
        (error) =>
          new ConnectionTransientError({
            reason: "transport",
            detail: `${connection.label} did not respond to a connection health check: ${error.message}`,
          }),
      ),
      Effect.asVoid,
      Effect.withSpan("clientRuntime.connection.rpcSession.probe"),
    );

    // Closing the scope closes the socket, which ends the session.
    yield* Effect.addFinalizer(() =>
      terminate(
        new ConnectionTransientError({
          reason: "transport",
          detail: `${connection.label} closed the session.`,
        }),
      ),
    );

    return {
      client,
      welcome: welcomeEffect,
      initialConfig,
      ready: welcomeEffect.pipe(
        Effect.andThen(initialConfig),
        Effect.asVoid,
      ),
      probe,
      closed: Deferred.await(terminated),
      pendingRequests: Ref.get(pending).pipe(Effect.map((current) => current.size)),
      sequenceGaps: Stream.unwrap(Effect.map(PubSub.subscribe(gaps), Stream.fromSubscription)),
    } satisfies RpcSession;
  });

  return RpcSessionFactory.of({ connect });
});

export const layer = (options: RpcSessionOptions = {}) =>
  Layer.effect(RpcSessionFactory, make(options));
