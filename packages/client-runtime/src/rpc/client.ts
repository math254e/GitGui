/**
 * Vendored from T3 Code (`packages/client-runtime/src/rpc/client.ts`).
 *
 * Upstream: t3code @ 1688f965682d331da16a8c39f049592361f69c8d
 * (`v0.1.2-nightly.20261021.3473`).
 *
 * Divergences from upstream:
 * - T3 Code addresses RPC methods through a typed `effect/rpc` group and
 *   splits them into unary, subscription, and stream tags. GitGui's envelope
 *   is method-addressed, so the client exposes one `request` and one
 *   `subscribeEvents` instead of a tag union. The method, its payload, and
 *   its result are still typed, through the generated contract.
 * - The client-side `RpcPermissionGuard` is gone: GitGui's scopes are decided
 *   by the server, and the client has no privileged command boundary.
 */
import type { OrderedEventEnvelope } from "@gitgui/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import {
  GitGuiRpcError,
  type GitGuiRpcMethod,
  type GitGuiRpcMethods,
  type GitGuiRpcProtocolClient,
} from "./protocol.ts";

export class EnvironmentRpcUnavailableError extends Schema.TaggedError<EnvironmentRpcUnavailableError>()(
  "EnvironmentRpcUnavailableError",
  {
    environmentId: Schema.String,
    message: Schema.String,
  },
) {}

export interface EnvironmentRpcRequestObservation {
  readonly environmentId: string;
  readonly environmentLabel: string;
  readonly method: string;
}

export class EnvironmentRpcRequestObserver extends Context.Reference<{
  readonly observe: (
    request: EnvironmentRpcRequestObservation,
  ) => Effect.Effect<Effect.Effect<void>>;
}>("@gitgui/client-runtime/rpc/EnvironmentRpcRequestObserver", {
  defaultValue: () => ({
    observe: () => Effect.succeed(Effect.void),
  }),
}) {}

export interface EnvironmentRpcSubscriptionObservation {
  readonly environmentId: string;
  readonly method: string;
}

export class EnvironmentRpcSubscriptionObserver extends Context.Reference<{
  readonly observe: (
    subscription: EnvironmentRpcSubscriptionObservation,
  ) => Effect.Effect<Effect.Effect<void>>;
}>("@gitgui/client-runtime/rpc/EnvironmentRpcSubscriptionObserver", {
  defaultValue: () => ({
    observe: () => Effect.succeed(Effect.void),
  }),
}) {}

export const currentSession = Effect.fn("EnvironmentRpc.currentSession")(function* () {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  return yield* SubscriptionRef.get(supervisor.session).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new EnvironmentRpcUnavailableError({
              environmentId: supervisor.target.environmentId,
              message: `${supervisor.target.label} is not connected.`,
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );
});

/**
 * Runs one RPC against the environment's current session.
 *
 * A replaced session is resolved here, so a request issued while the
 * supervisor swaps its session either uses the old session or the new one,
 * never a half-open socket.
 */
export const request = <K extends GitGuiRpcMethod>(
  method: K,
  input: GitGuiRpcMethods[K]["input"],
): Effect.Effect<
  GitGuiRpcMethods[K]["output"],
  EnvironmentRpcUnavailableError | GitGuiRpcError,
  EnvironmentSupervisor.EnvironmentSupervisor
> =>
  Effect.gen(function* () {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    yield* Effect.annotateCurrentSpan({
      "environment.id": supervisor.target.environmentId,
      "rpc.method": method,
    });
    const session = yield* currentSession();
    const observer = yield* EnvironmentRpcRequestObserver;
    const completeObservation = yield* observer.observe({
      environmentId: supervisor.target.environmentId,
      environmentLabel: supervisor.target.label,
      method,
    });
    return yield* session.client.call(method, input).pipe(Effect.ensuring(completeObservation));
  });

/**
 * The environment's server-sent events.
 *
 * The stream follows the supervisor's session, so a replaced session
 * re-subscribes instead of leaving the caller on a dead socket.
 */
export const subscribeEvents = (): Stream.Stream<
  OrderedEventEnvelope,
  GitGuiRpcError,
  EnvironmentSupervisor.EnvironmentSupervisor
> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
      const observer = yield* EnvironmentRpcSubscriptionObserver;
      const completeObservation = yield* observer.observe({
        environmentId: supervisor.target.environmentId,
        method: "events",
      });
      return SubscriptionRef.changes(supervisor.session).pipe(
        Stream.switchMap(
          Option.match({
            onNone: () => Stream.empty,
            onSome: (session: { readonly client: GitGuiRpcProtocolClient }) => session.client.events,
          }),
        ),
        Stream.ensuring(completeObservation),
      );
    }),
  );
