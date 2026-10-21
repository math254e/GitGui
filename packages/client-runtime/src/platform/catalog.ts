/**
 * The client-owned connection catalog, persisted through a platform backend.
 *
 * Not vendored from T3 Code: T3 Code stores the catalog through its own
 * platform layer. GitGui keeps the same service split, but the record shape
 * is GitGui's own, and the desktop shell persists the record verbatim.
 */
import { EnvironmentId } from "@gitgui/contracts/environment";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import type { ConnectionCredential, ConnectionProfile, ConnectionRegistration } from "../connection/catalog.ts";
import { ConnectionBlockedError } from "../connection/model.ts";
import type { ConnectionTarget, PersistedConnectionTarget } from "../connection/model.ts";
import { ConnectionCredentialStore } from "../connection/credentialStore.ts";
import { ConnectionProfileStore } from "../connection/profileStore.ts";
import {
  ConnectionPersistenceError,
  ConnectionRegistrationStore,
  ConnectionTargetStore,
} from "./persistence.ts";
import {
  PERSISTED_ENVIRONMENT_SCHEMA_VERSION,
  PersistedEnvironmentCatalog,
  type PersistedEnvironmentCatalog as Catalog,
  type PersistedEnvironmentRecord,
} from "./records.ts";

/** Where the client keeps its known environments and their credentials. */
export interface EnvironmentCatalogBackend {
  readonly read: () => Promise<Catalog>;
  readonly write: (catalog: Catalog) => Promise<void>;
  readonly readCredential: (environmentId: string) => Promise<ConnectionCredential | undefined>;
  readonly writeCredential: (
    environmentId: string,
    credential: ConnectionCredential,
  ) => Promise<void>;
  readonly removeCredential: (environmentId: string) => Promise<void>;
}

const emptyCatalog: Catalog = {
  schemaVersion: PERSISTED_ENVIRONMENT_SCHEMA_VERSION,
  environments: [],
};

export const parseCatalog = (value: unknown): Catalog => {
  const decoded = Schema.decodeUnknownOption(PersistedEnvironmentCatalog)(value);
  return decoded._tag === "Some" ? decoded.value : emptyCatalog;
};

type PersistenceOperation =
  | "list-targets"
  | "list-disabled-targets"
  | "register-connection"
  | "set-connection-routes"
  | "remove-connection"
  | "set-connection-enabled"
  | "clear-environment";

const failure = (operation: PersistenceOperation, cause: unknown) =>
  new ConnectionPersistenceError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

/** The credential and profile stores report a blocked connection, like T3 Code. */
const blocked = (cause: unknown) =>
  new ConnectionBlockedError({
    reason: "configuration",
    detail: cause instanceof Error ? cause.message : String(cause),
  });

// All catalog writers share a lock: separate environment leases can update
// the same document concurrently, including profiles learned by a supervisor.
const catalogLocks = new WeakMap<EnvironmentCatalogBackend, Semaphore.Semaphore>();
const updateCatalog = (backend: EnvironmentCatalogBackend, update: (catalog: Catalog) => Catalog) => {
  let lock = catalogLocks.get(backend);
  if (lock === undefined) {
    lock = Semaphore.makeUnsafe(1);
    catalogLocks.set(backend, lock);
  }
  return lock.withPermit(Effect.tryPromise(() => backend.read()).pipe(
    Effect.flatMap((catalog) => Effect.tryPromise(() => backend.write(update(catalog)))),
  ));
};

const storedProfiles = (environment: PersistedEnvironmentRecord): ReadonlyArray<ConnectionProfile> =>
  environment.profiles ?? [environment.registration.profile];

const retainProfiles = (profiles: ReadonlyArray<ConnectionProfile>, routes: ReadonlyArray<PersistedConnectionTarget>) =>
  profiles.filter((profile) => routes.some((route) =>
    route.connectionId === profile.connectionId));

export const makeTargetStore = (backend: EnvironmentCatalogBackend) =>
  Effect.gen(function* () {
    const read = Effect.tryPromise({
      try: () => backend.read(),
      catch: (cause) => failure("list-targets", cause),
    });
    const list = read.pipe(
      Effect.map((catalog) =>
        catalog.environments.flatMap((environment) =>
          environment.routes.map((route) => route as ConnectionTarget),
        ),
      ),
    );
    const listDisabled = read.pipe(
      Effect.map((catalog) =>
        catalog.environments
          .filter((environment) => !environment.enabled)
          .map((environment) => environment.environmentId as EnvironmentId),
      ),
    );
    return ConnectionTargetStore.of({ list, listDisabled });
  });

export const makeRegistrationStore = (backend: EnvironmentCatalogBackend) =>
  Effect.gen(function* () {
    const write = (update: (catalog: Catalog) => Catalog) =>
      updateCatalog(backend, update).pipe(Effect.mapError((cause) => failure("register-connection", cause)));

    const register = (
      registration: ConnectionRegistration,
      routes: ReadonlyArray<PersistedConnectionTarget>,
    ) =>
      Effect.tryPromise({
        try: () => backend.writeCredential(registration.target.environmentId, registration.credential),
        catch: (cause) => failure("register-connection", cause),
      }).pipe(Effect.andThen(write((catalog) => {
        const environmentId = registration.target.environmentId;
        const previous = catalog.environments.find((environment) => environment.environmentId === environmentId);
        const profiles = (previous === undefined ? [] : storedProfiles(previous))
          .filter((profile) => profile.connectionId !== registration.profile.connectionId);
        // Construct the non-secret record explicitly; object spreading would
        // copy the pairing-time credential into ordinary desktop settings.
        const savedRegistration = {
          _tag: registration._tag,
          target: registration.target,
          profile: registration.profile,
        } as PersistedEnvironmentRecord["registration"];
        return { ...catalog, environments: [
          ...catalog.environments.filter((environment) => environment.environmentId !== environmentId),
          {
            schemaVersion: PERSISTED_ENVIRONMENT_SCHEMA_VERSION,
            environmentId,
            registration: savedRegistration,
            profiles: retainProfiles([...profiles, registration.profile], routes),
            routes: [...routes],
            enabled: true,
          },
        ] };
      })));

    const setRoutes = (
      environmentId: EnvironmentId,
      routes: ReadonlyArray<PersistedConnectionTarget>,
    ) =>
      write((catalog) => ({
        ...catalog,
        environments: catalog.environments.map((environment) =>
          environment.environmentId === environmentId
            ? { ...environment, routes: [...routes], profiles: retainProfiles(storedProfiles(environment), routes) }
            : environment,
        ),
      }));

    const remove = (environmentId: EnvironmentId) =>
      write((catalog) => {
        const { selectedEnvironmentId, ...rest } = catalog;
        return {
          ...rest,
          ...(selectedEnvironmentId === undefined || selectedEnvironmentId === environmentId
            ? {} : { selectedEnvironmentId }),
          environments: catalog.environments.filter((environment) => environment.environmentId !== environmentId),
        };
      }).pipe(Effect.andThen(Effect.tryPromise({
        try: () => backend.removeCredential(environmentId),
        catch: (cause) => failure("remove-connection", cause),
      })));

    const setEnabled = (environmentId: EnvironmentId, enabled: boolean) =>
      write((catalog) => ({
        ...catalog,
        environments: catalog.environments.map((environment) =>
          environment.environmentId === environmentId ? { ...environment, enabled } : environment,
        ),
      }));

    return ConnectionRegistrationStore.of({ register, setRoutes, remove, setEnabled });
  });

export const makeCredentialStore = (backend: EnvironmentCatalogBackend) =>
  Effect.gen(function* () {
    const get = (environmentId: string) =>
      Effect.tryPromise({
        try: () => backend.readCredential(environmentId),
        catch: blocked,
      }).pipe(Effect.map((credential) => (credential === undefined ? Option.none() : Option.some(credential))));
    const put = (environmentId: string, credential: ConnectionCredential) =>
      Effect.tryPromise({
        try: () => backend.writeCredential(environmentId, credential),
        catch: blocked,
      });
    const remove = (environmentId: string) =>
      Effect.tryPromise({
        try: () => backend.removeCredential(environmentId),
        catch: blocked,
      });
    return ConnectionCredentialStore.of({ get, put, remove });
  });

/** Every saved or learned route retains its own non-secret profile. */
export const makeProfileStore = (backend: EnvironmentCatalogBackend) =>
  Effect.gen(function* () {
    const get = (connectionId: string) =>
      Effect.tryPromise({ try: () => backend.read(), catch: blocked }).pipe(
        Effect.map((catalog) => Option.fromUndefinedOr(catalog.environments
          .flatMap(storedProfiles).find((profile) => profile.connectionId === connectionId))),
      );
    const put = (profile: ConnectionProfile) => updateCatalog(backend, (catalog) => ({
      ...catalog,
      environments: catalog.environments.map((environment) => environment.environmentId === profile.environmentId
        ? { ...environment, profiles: [
            ...storedProfiles(environment).filter((existing) => existing.connectionId !== profile.connectionId),
            profile,
          ] }
        : environment),
    })).pipe(Effect.mapError(blocked));
    const remove = (connectionId: string) => updateCatalog(backend, (catalog) => ({
      ...catalog,
      environments: catalog.environments.map((environment) => ({
        ...environment,
        profiles: storedProfiles(environment).filter((profile) => profile.connectionId !== connectionId),
      })),
    })).pipe(Effect.mapError(blocked));
    return ConnectionProfileStore.of({ get, put, remove });
  });

export const layerConnectionPersistence = (backend: EnvironmentCatalogBackend) =>
  Layer.mergeAll(
    Layer.effect(ConnectionTargetStore, makeTargetStore(backend)),
    Layer.effect(ConnectionRegistrationStore, makeRegistrationStore(backend)),
    Layer.effect(ConnectionCredentialStore, makeCredentialStore(backend)),
    Layer.effect(ConnectionProfileStore, makeProfileStore(backend)),
  );
