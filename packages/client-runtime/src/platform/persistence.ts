/**
 * Vendored from T3 Code (`packages/client-runtime/src/platform/persistence.ts`).
 *
 * Upstream: t3code @ 1688f965682d331da16a8c39f049592361f69c8d
 * (`v0.1.2-nightly.20261021.3473`).
 *
 * Divergences from upstream:
 * - `EnvironmentCacheStore` is gone: GitGui caches no server-owned snapshots.
 *   The client owns its tabs and recents in the browser, and that state is
 *   cleared by the client, not by the connection runtime.
 * - Registration storage separates secrets; removal clears its credential.
 * - The persistence error operations list only the ones GitGui performs.
 */
import type { EnvironmentId } from "@gitgui/contracts/environment";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ConnectionRegistration } from "../connection/catalog.ts";
import type { ConnectionTarget, PersistedConnectionTarget } from "../connection/model.ts";

export class ConnectionPersistenceError extends Schema.TaggedError<ConnectionPersistenceError>()(
  "ConnectionPersistenceError",
  {
    operation: Schema.Literals([
      "list-targets",
      "list-disabled-targets",
      "register-connection",
      "set-connection-routes",
      "remove-connection",
      "set-connection-enabled",
      "clear-environment",
    ]),
    message: Schema.String,
  },
) {}

export class ConnectionTargetStore extends Context.Service<
  ConnectionTargetStore,
  {
    readonly list: Effect.Effect<ReadonlyArray<ConnectionTarget>, ConnectionPersistenceError>;
    readonly listDisabled: Effect.Effect<ReadonlyArray<EnvironmentId>, ConnectionPersistenceError>;
  }
>()("@gitgui/client-runtime/platform/persistence/ConnectionTargetStore") {}

export class ConnectionRegistrationStore extends Context.Service<
  ConnectionRegistrationStore,
  {
    /**
     * Stores credentials separately before installing the non-secret record.
     * Records of routes missing from `routes` are dropped.
     */
    readonly register: (
      registration: ConnectionRegistration,
      routes: ReadonlyArray<PersistedConnectionTarget>,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    /**
     * `routes` must not be empty.
     */
    readonly setRoutes: (
      environmentId: EnvironmentId,
      routes: ReadonlyArray<PersistedConnectionTarget>,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    /** Removes the registration, its profiles, and its protected credential. */
    readonly remove: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
    readonly setEnabled: (
      environmentId: EnvironmentId,
      enabled: boolean,
    ) => Effect.Effect<void, ConnectionPersistenceError>;
  }
>()("@gitgui/client-runtime/platform/persistence/ConnectionRegistrationStore") {}

export class EnvironmentOwnedDataCleanup extends Context.Reference<{
  readonly clear: (environmentId: EnvironmentId) => Effect.Effect<void>;
}>("@gitgui/client-runtime/platform/persistence/EnvironmentOwnedDataCleanup", {
  defaultValue: () => ({
    clear: () => Effect.void,
  }),
}) {}
