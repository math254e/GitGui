/**
 * Vendored from T3 Code (`packages/client-runtime/src/connection/credentialStore.ts`).
 *
 * Upstream: t3code @ 1688f965682d331da16a8c39f049592361f69c8d
 * (`v0.1.2-nightly.20261021.3473`).
 *
 * Divergences from upstream:
 * - None in the implementation; package service keys are renamed where needed.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { ConnectionCredential } from "./catalog.ts";
import type { ConnectionAttemptError } from "./model.ts";

export class ConnectionCredentialStore extends Context.Service<
  ConnectionCredentialStore,
  {
    readonly get: (
      connectionId: string,
    ) => Effect.Effect<Option.Option<ConnectionCredential>, ConnectionAttemptError>;
    readonly put: (
      connectionId: string,
      credential: ConnectionCredential,
    ) => Effect.Effect<void, ConnectionAttemptError>;
    readonly remove: (connectionId: string) => Effect.Effect<void, ConnectionAttemptError>;
  }
>()("@gitgui/client-runtime/connection/credentialStore/ConnectionCredentialStore") {}

export const make = (service: ConnectionCredentialStore["Service"]) =>
  ConnectionCredentialStore.of(service);
