/**
 * The client-owned record of one known environment.
 *
 * The desktop shell persists this record verbatim; it does not interpret it.
 * The schema lives in the client runtime because the client owns the
 * connection catalog.
 */
import { EnvironmentId } from "@gitgui/contracts/environment";
import * as Schema from "effect/Schema";

import { BearerConnectionProfile, SshConnectionProfile, ConnectionProfile, ConnectionCredential } from "../connection/catalog.ts";
import { BearerConnectionTarget, SshConnectionTarget, PersistedConnectionTarget } from "../connection/model.ts";

export const PERSISTED_ENVIRONMENT_SCHEMA_VERSION = 1;

/** Registrations carry credentials only at pairing time, never on disk. */
export const PersistedConnectionRegistration = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("BearerConnectionRegistration"),
    target: BearerConnectionTarget,
    profile: BearerConnectionProfile,
  }),
  Schema.Struct({
    _tag: Schema.Literal("SshConnectionRegistration"),
    target: SshConnectionTarget,
    profile: SshConnectionProfile,
  }),
]);

export const PersistedEnvironmentRecord = Schema.Struct({
  schemaVersion: Schema.Literal(PERSISTED_ENVIRONMENT_SCHEMA_VERSION),
  environmentId: EnvironmentId,
  registration: PersistedConnectionRegistration,
  profiles: Schema.optionalKey(Schema.Array(ConnectionProfile)),
  routes: Schema.Array(PersistedConnectionTarget),
  enabled: Schema.Boolean,
  /** The selected environment, kept with the catalog so both stay consistent. */
  selected: Schema.optionalKey(Schema.Boolean),
});
export type PersistedEnvironmentRecord = typeof PersistedEnvironmentRecord.Type;

export const PersistedEnvironmentCatalog = Schema.Struct({
  schemaVersion: Schema.Literal(PERSISTED_ENVIRONMENT_SCHEMA_VERSION),
  environments: Schema.Array(PersistedEnvironmentRecord),
  selectedEnvironmentId: Schema.optionalKey(EnvironmentId),
});
export type PersistedEnvironmentCatalog = typeof PersistedEnvironmentCatalog.Type;

export type { ConnectionCredential };
