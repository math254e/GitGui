/**
 * Vendored from T3 Code (`packages/client-runtime/src/platform/capabilities.ts`).
 *
 * Upstream: t3code @ 1688f965682d331da16a8c39f049592361f69c8d
 * (`v0.1.2-nightly.20261021.3473`).
 *
 * Divergences from upstream:
 * - The cloud session, the relay device identity, and the analytics device id
 *   are gone: GitGui has no cloud account.
 * - SSH provisioning returns a provisional acquisition with explicit commit
 *   and cancellation. GitGui authenticates directly over HTTP and verifies RPC
 *   before saving and claiming the Rust host instance.
 * - Prepare/provision require a scope that owns cancellation before IPC;
 *   explicit handoff transfers the claimed handle to the durable connection ID.
 * - Existing-directory provisioning can pin the previously saved environment ID.
 */
import type { EnvironmentDescriptor, EnvironmentId, SshEnvironmentTarget } from "@gitgui/contracts/environment";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Scope from "effect/Scope";

import type { ConnectionAttemptError } from "../connection/model.ts";
import type { ClientPresentationMetadata } from "../authorization/remote.ts";

export interface PreparedSshEnvironment {
  readonly bootstrap: {
    readonly httpBaseUrl: string;
    readonly wsBaseUrl: string;
    readonly environmentId: EnvironmentId;
  };
  readonly bearerToken: string;
  readonly descriptor?: EnvironmentDescriptor;
  readonly target?: SshEnvironmentTarget;
  readonly commit?: Effect.Effect<void, ConnectionAttemptError>;
  /** Transfer the scoped acquisition after durable activation. */
  readonly handoff?: (connectionId: string) => Effect.Effect<void>;
  readonly cancel?: Effect.Effect<void>;
}

export class ClientPresentation extends Context.Service<
  ClientPresentation,
  {
    readonly metadata: ClientPresentationMetadata;
  }
>()("@gitgui/client-runtime/platform/capabilities/ClientPresentation") {}

/**
 * The credential the primary environment accepts.
 *
 * The desktop shell owns the bootstrap credential and exchanges it for a
 * scoped bearer session, so the runtime only ever sees a bearer token.
 */
export class PrimaryEnvironmentAuth extends Context.Service<
  PrimaryEnvironmentAuth,
  {
    readonly bearerToken: Effect.Effect<Option.Option<string>, ConnectionAttemptError>;
  }
>()("@gitgui/client-runtime/platform/capabilities/PrimaryEnvironmentAuth") {}

export class SshEnvironmentGateway extends Context.Service<
  SshEnvironmentGateway,
  {
    readonly provision?: (target: SshEnvironmentTarget, credential?: { readonly kind: string; readonly token: string }, expectedEnvironmentId?: EnvironmentId) => Effect.Effect<PreparedSshEnvironment, ConnectionAttemptError, Scope.Scope>;
    /**
     * Starts or reuses the remote server for a saved connection. Returns the
     * token this client saved from an earlier pairing, while the host still
     * accepts it with the standard scopes, and pairs again only when it does
     * not, so a reconnect adds no session on the host.
     */
    readonly prepare: (input: {
      readonly connectionId: string;
      readonly expectedEnvironmentId: EnvironmentId;
      readonly target: SshEnvironmentTarget;
      readonly bearerToken?: string;
    }) => Effect.Effect<PreparedSshEnvironment, ConnectionAttemptError, Scope.Scope>;
    readonly disconnect: (
      target: SshEnvironmentTarget,
    ) => Effect.Effect<void, ConnectionAttemptError>;
  }
>()("@gitgui/client-runtime/platform/capabilities/SshEnvironmentGateway") {}
