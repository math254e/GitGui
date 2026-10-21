/**
 * The platform services the Effect connection runtime needs.
 *
 * The runtime is platform-independent: it asks for credentials, network
 * status, wakeups, and the primary environment through Effect services. This
 * module is the web application's implementation of those services.
 */
import type {
  DesktopBridge,
  DesktopConnectionRegistration,
  DesktopCredential,
  DesktopPreparedConnection,
  DesktopSshHost,
} from "@gitgui/contracts/desktop";
import {
  type EnvironmentDescriptor as EnvironmentDescriptorType,
  EnvironmentId,
} from "@gitgui/contracts/environment";
import {
  BearerConnectionCredential,
  ConnectionCredential,
  PrimaryConnectionRegistration,
  type PlatformConnectionRegistration,
} from "@gitgui/client-runtime/connection/catalog";
import { PrimaryConnectionTarget } from "@gitgui/client-runtime/connection/model";
import { ConnectionCredentialStore } from "@gitgui/client-runtime/connection/credentialStore";
import { layer as connectionLayer } from "@gitgui/client-runtime/connection/layer";
import * as Connectivity from "@gitgui/client-runtime/connection/connectivity";
import * as ConnectionWakeups from "@gitgui/client-runtime/connection/wakeups";
import { bootstrapRemoteBearerSession, fetchRemoteSessionState } from "@gitgui/client-runtime/authorization/remote";
import { mapRemoteEnvironmentError, environmentMismatchError } from "@gitgui/client-runtime/connection/errors";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  type ConnectionAttemptError,
} from "@gitgui/client-runtime/connection/model";
import { fetchRemoteEnvironmentDescriptor } from "@gitgui/client-runtime/environment/descriptor";
import { layerRemoteHttpClient } from "@gitgui/client-runtime/rpc/http";
import * as ClientCapabilities from "@gitgui/client-runtime/platform/capabilities";
import { layerConnectionPersistence } from "@gitgui/client-runtime/platform/catalog";
import { EnvironmentOwnedDataCleanup } from "@gitgui/client-runtime/platform/persistence";
import { LocalStorageWorkspaceMetadataAdapter } from "../client-runtime/metadata";
import type { EnvironmentCatalogBackend } from "@gitgui/client-runtime/platform/catalog";
import {
  PERSISTED_ENVIRONMENT_SCHEMA_VERSION,
  PersistedEnvironmentRecord,
  type PersistedEnvironmentCatalog,
} from "@gitgui/client-runtime/platform/records";
import * as PlatformConnectionSource from "@gitgui/client-runtime/platform/source";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpClient from "effect/http/HttpClient";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";

const CATALOG_KEY = "gitgui.connections.v3";
const SELECTED_KEY = "gitgui.selectedEnvironment.v3";
const CREDENTIAL_PREFIX = "gitgui.credential.v3.";

export interface WebConnectionOptions {
  readonly desktop: DesktopBridge | null;
  readonly storage: Storage;
  readonly fetchFn: typeof globalThis.fetch;
  readonly appVersion?: string;
}

export function readDesktopBridge(): DesktopBridge | null {
  return (globalThis as { desktopBridge?: DesktopBridge | null }).desktopBridge ?? null;
}

/* -------------------------------------------------------------------------- */
/* Catalog persistence                                                        */
/* -------------------------------------------------------------------------- */

interface StoredCatalog {
  readonly schemaVersion: number;
  readonly environments: ReadonlyArray<unknown>;
}

const parseStoredCatalog = (value: unknown): StoredCatalog => {
  if (typeof value !== "object" || value === null) {
    return { schemaVersion: PERSISTED_ENVIRONMENT_SCHEMA_VERSION, environments: [] };
  }
  const record = value as Record<string, unknown>;
  return {
    schemaVersion:
      typeof record["schemaVersion"] === "number"
        ? record["schemaVersion"]
        : PERSISTED_ENVIRONMENT_SCHEMA_VERSION,
    environments: Array.isArray(record["environments"]) ? record["environments"] : [],
  };
};

const readBrowserCatalog = (storage: Storage): StoredCatalog => {
  try { return parseStoredCatalog(JSON.parse(storage.getItem(CATALOG_KEY) ?? "null")); }
  catch { return { schemaVersion: PERSISTED_ENVIRONMENT_SCHEMA_VERSION, environments: [] }; }
};

const selectedEnvironment = (storage: Storage) => {
  const selected = Schema.decodeUnknownOption(EnvironmentId)(storage.getItem(SELECTED_KEY));
  return Option.isSome(selected) ? { selectedEnvironmentId: selected.value } : {};
};

// Selection is a separate client setting. Catalog writes may clear it only
// when they actually remove the selected saved environment, never overwrite it
// with a snapshot taken before a user changed selection.
const clearRemovedSelection = (
  storage: Storage,
  previous: ReadonlyArray<{ readonly environmentId: string }>,
  next: ReadonlyArray<{ readonly environmentId: string }>,
) => {
  const selected = storage.getItem(SELECTED_KEY);
  if (selected !== null && previous.some((entry) => entry.environmentId === selected) &&
      !next.some((entry) => entry.environmentId === selected)) storage.removeItem(SELECTED_KEY);
};

const decodeRecord = (value: unknown) => {
  const decoded = Schema.decodeUnknownOption(PersistedEnvironmentRecord)(value);
  return decoded._tag === "Some" ? decoded.value : undefined;
};

/** Move credentials from the early catalog format before rewriting it. */
const migrateRecord = async (value: unknown, backend: EnvironmentCatalogBackend) => {
  const record = decodeRecord(value);
  if (record === undefined) return undefined;
  const legacy = value as { registration?: { credential?: unknown } };
  const credential = Schema.decodeUnknownOption(ConnectionCredential)(legacy.registration?.credential);
  if (Option.isSome(credential)) {
    const saved = await backend.readCredential(record.environmentId);
    if (saved === undefined) await backend.writeCredential(record.environmentId, credential.value);
  }
  return { record, migrated: legacy.registration?.credential !== undefined };
};

class LocalStorageCatalogBackend implements EnvironmentCatalogBackend {
  constructor(private readonly storage: Storage) {}

  async read(): Promise<PersistedEnvironmentCatalog> {
    const parsed = readBrowserCatalog(this.storage);
    const decoded = await Promise.all(parsed.environments.map((candidate) => migrateRecord(candidate, this)));
    const catalog: PersistedEnvironmentCatalog = {
      schemaVersion: PERSISTED_ENVIRONMENT_SCHEMA_VERSION,
      environments: decoded.flatMap((value) => value === undefined ? [] : [value.record]),
      ...selectedEnvironment(this.storage),
    };
    if (decoded.some((value) => value?.migrated)) await this.write(catalog);
    return catalog;
  }

  async write(catalog: PersistedEnvironmentCatalog) {
    const previous = readBrowserCatalog(this.storage).environments.flatMap((value) => {
      const record = decodeRecord(value);
      return record === undefined ? [] : [record];
    });
    this.storage.setItem(CATALOG_KEY, JSON.stringify({
      schemaVersion: PERSISTED_ENVIRONMENT_SCHEMA_VERSION,
      environments: catalog.environments,
    }));
    clearRemovedSelection(this.storage, previous, catalog.environments);
  }

  async readCredential(environmentId: string): Promise<ConnectionCredential | undefined> {
    const raw = this.storage.getItem(CREDENTIAL_PREFIX + encodeURIComponent(environmentId));
    if (!raw) return undefined;
    try {
      const decoded = Schema.decodeUnknownOption(ConnectionCredential)(JSON.parse(raw));
      return decoded._tag === "Some" ? decoded.value : undefined;
    } catch {
      return undefined;
    }
  }

  async writeCredential(environmentId: string, credential: ConnectionCredential) {
    this.storage.setItem(
      CREDENTIAL_PREFIX + encodeURIComponent(environmentId),
      JSON.stringify(credential),
    );
  }

  async removeCredential(environmentId: string) {
    this.storage.removeItem(CREDENTIAL_PREFIX + encodeURIComponent(environmentId));
  }
}

class DesktopCatalogBackend implements EnvironmentCatalogBackend {
  constructor(
    private readonly desktop: DesktopBridge,
    private readonly storage: Storage,
  ) {}

  async read(): Promise<PersistedEnvironmentCatalog> {
    const records = await this.desktop.listConnectionRegistrations();
    const decoded = await Promise.all(records.map(async (entry) => {
      let value: unknown;
      try { value = JSON.parse(entry.record); } catch { return undefined; }
      return migrateRecord(value, this);
    }));
    const catalog: PersistedEnvironmentCatalog = {
      schemaVersion: PERSISTED_ENVIRONMENT_SCHEMA_VERSION,
      environments: decoded.flatMap((value) => value === undefined ? [] : [value.record]),
      ...selectedEnvironment(this.storage),
    };
    if (decoded.some((value) => value?.migrated)) await this.write(catalog);
    return catalog;
  }

  async write(catalog: PersistedEnvironmentCatalog) {
    const existing = await this.desktop.listConnectionRegistrations();
    const wanted = new Set<string>(
      catalog.environments.map((environment) => environment.environmentId as string),
    );
    for (const record of existing) {
      if (!wanted.has(record.environmentId)) {
        await this.desktop.removeConnectionRegistration(record.environmentId);
      }
    }
    for (const environment of catalog.environments) {
      const registration = {
        environmentId: environment.environmentId,
        displayName: environment.registration.target.label,
        record: JSON.stringify(environment),
        capabilities: [],
        protocolVersion: 2,
      } as unknown as DesktopConnectionRegistration;
      await this.desktop.saveConnectionRegistration(registration);
    }
    clearRemovedSelection(this.storage, existing, catalog.environments);
  }

  async readCredential(environmentId: string): Promise<ConnectionCredential | undefined> {
    const credential = await this.desktop.getCredential(environmentId);
    if (!credential) return undefined;
    const decoded = Schema.decodeUnknownOption(ConnectionCredential)({
      _tag: "BearerConnectionCredential",
      token: credential.token,
      ...(credential.expiresAt === undefined ? {} : { expiresAt: credential.expiresAt }),
    });
    return decoded._tag === "Some" ? decoded.value : undefined;
  }

  async writeCredential(environmentId: string, credential: ConnectionCredential) {
    const desktopCredential: DesktopCredential = {
      kind: "bearer",
      token: credential.token,
      ...(credential.expiresAt === undefined ? {} : { expiresAt: credential.expiresAt }),
    };
    await this.desktop.setCredential(environmentId, desktopCredential);
  }

  async removeCredential(environmentId: string) {
    await this.desktop.removeCredential(environmentId);
  }
}

/**
 * The selected environment is client-owned and lives beside the catalog.
 */
export const readSelectedEnvironmentId = async (
  options: WebConnectionOptions,
): Promise<string | undefined> =>
  options.storage.getItem(SELECTED_KEY) ?? undefined;

export const writeSelectedEnvironmentId = async (
  options: WebConnectionOptions,
  environmentId: string | undefined,
): Promise<void> => {
  if (environmentId === undefined) {
    options.storage.removeItem(SELECTED_KEY);
    return;
  }
  options.storage.setItem(SELECTED_KEY, environmentId);
};

export const createCatalogBackend = (options: WebConnectionOptions): EnvironmentCatalogBackend =>
  options.desktop
    ? new DesktopCatalogBackend(options.desktop, options.storage)
    : new LocalStorageCatalogBackend(options.storage);

/* -------------------------------------------------------------------------- */
/* Platform services                                                          */
/* -------------------------------------------------------------------------- */

export const validateDirectEndpoint = (endpoint: string, desktop: boolean): void => {
  const url = new URL(endpoint);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Connection URLs cannot contain credentials, query parameters, or fragments");
  }
  const loopback =
    url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Connection URLs must use HTTP or HTTPS");
  }
  if (!desktop && url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Browser connections require HTTPS except on loopback");
  }
  if (!desktop && window.location.protocol === "https:" && url.protocol !== "https:") {
    throw new Error("An HTTPS client cannot connect to an HTTP backend");
  }
};

const toWebSocketBaseUrl = (httpUrl: string): string => {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
};

export interface PrimaryEnvironment {
  readonly httpUrl: string;
  readonly descriptor: EnvironmentDescriptorType;
  readonly credential?: DesktopCredential;
}

const fetchDescriptor = (httpUrl: string, fetchFn: typeof globalThis.fetch) =>
  fetchRemoteEnvironmentDescriptor({ httpBaseUrl: httpUrl }).pipe(
    Effect.mapError(mapRemoteEnvironmentError),
    Effect.provide(layerRemoteHttpClient(fetchFn)),
  );

const desktopFailure = (cause: unknown) => new ConnectionTransientError({
  reason: "remote-unavailable", detail: cause instanceof Error ? cause.message : "The desktop environment is unavailable.",
});

// Electron preserves the SSH manager's error message across the IPC rejection.
// Cancellation and rejected credentials/trust require user action; retrying them
// as transport failures would immediately reopen the same prompts.
const sshFailure = (cause: unknown): ConnectionAttemptError => {
  const detail = cause instanceof Error ? cause.message : "The SSH connection is unavailable.";
  if (/SSH authentication was cancel(?:led|ed)|permission denied|authentication failed|too many authentication failures|(?:bad|incorrect) passphrase/i.test(detail)) {
    return new ConnectionBlockedError({ reason: "authentication", detail });
  }
  if (/SSH host-key confirmation was cancel(?:led|ed)|host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(detail)) {
    return new ConnectionBlockedError({ reason: "permission", detail });
  }
  return desktopFailure(cause);
};

/** The primary environment: the desktop's own backend, or the page's origin. */
const readPrimaryEnvironment = (
  options: WebConnectionOptions,
) => {
  let browserCredential: DesktopCredential | undefined;
  return Effect.gen(function* () {
    if (options.desktop) {
      const prepared: DesktopPreparedConnection = yield* Effect.tryPromise({
        try: () => options.desktop!.getPrimaryEnvironment(), catch: desktopFailure,
      });
      const descriptor = yield* fetchDescriptor(prepared.httpUrl, options.fetchFn);
      return {
        httpUrl: prepared.httpUrl,
        descriptor,
        ...(prepared.credential === undefined ? {} : { credential: prepared.credential }),
      };
    }
    const page = new URL(window.location.href);
    const endpoint = page.searchParams.get("server")?.trim() || window.location.origin;
    yield* Effect.try({
      try: () => validateDirectEndpoint(endpoint, false),
      catch: () => new ConnectionBlockedError({ reason: "configuration", detail: "The primary environment endpoint is invalid." }),
    });
    const fragment = new URLSearchParams(page.hash.replace(/^#/, ""));
    const token = fragment.get("token") ?? fragment.get("bootstrap") ?? fragment.get("session_token");
    if (token !== null) {
      browserCredential = { kind: fragment.has("session_token") ? "bearer" : "pairing", token };
    }
    if (page.hash) {
      page.hash = "";
      history.replaceState(history.state, "", page);
    }
    const descriptor = yield* fetchDescriptor(endpoint, options.fetchFn);
    return {
      httpUrl: endpoint,
      descriptor,
      ...(browserCredential === undefined ? {} : { credential: browserCredential }),
    };
  });
};

/** Shared by discovery and an explicit desktop restart. */
export const primaryConnectionRegistration = (primary: {
  readonly httpUrl: string;
  readonly descriptor: { readonly environmentId: string; readonly label: string };
}) => new PrimaryConnectionRegistration({ target: new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make(primary.descriptor.environmentId),
  label: primary.descriptor.label,
  httpBaseUrl: primary.httpUrl,
  wsBaseUrl: toWebSocketBaseUrl(primary.httpUrl),
}) });

// As in T3's platform source, discovery polls topology independently of the
// supervisor's transport retry loop. A failed refresh retains the last entry.
const makePrimarySource = (readPrimary: Effect.Effect<PrimaryEnvironment, ConnectionAttemptError>) =>
  Effect.gen(function* () {
    const wakeups = yield* ConnectionWakeups.ConnectionWakeups;
    const connectivity = yield* Connectivity.Connectivity;
    const triggers = Stream.mergeAll({ concurrency: "unbounded" })([
      Stream.tick("3 seconds").pipe(Stream.map(() => undefined)),
      wakeups.changes.pipe(Stream.map(() => undefined)),
      connectivity.changes.pipe(Stream.filter((status) => status === "online"), Stream.map(() => undefined)),
    ]);
    return PlatformConnectionSource.PlatformConnectionSource.of({
      registrations: triggers.pipe(
        Stream.mapEffect(() => readPrimary.pipe(
          Effect.map((primary) => Option.some([primaryConnectionRegistration(primary)] as ReadonlyArray<PlatformConnectionRegistration>)),
          Effect.catch(() => Effect.succeed(Option.none<ReadonlyArray<PlatformConnectionRegistration>>())),
        )),
        Stream.filter(Option.isSome),
        Stream.map((registration) => registration.value),
        Stream.changesWith((previous: ReadonlyArray<PlatformConnectionRegistration>, current) => Equal.equals(previous, current)),
      ),
    });
  });

/**
 * The primary environment's bearer session.
 *
 * The desktop shell owns the bootstrap credential; the client exchanges it for
 * a scoped bearer session and keeps that session until it expires.
 *
 * A development environment that does not require authentication accepts a
 * client that presents no credential at all and answers with its anonymous
 * session. The empty bearer is how that request is expressed: the
 * Authorization header is left off entirely.
 */
const ANONYMOUS_BEARER = "";

const makePrimaryEnvironmentAuth = (readPrimary: Effect.Effect<PrimaryEnvironment, ConnectionAttemptError>) =>
  Effect.gen(function* () {
    const credentials = yield* ConnectionCredentialStore;
    const httpClient = yield* HttpClient.HttpClient;
    const bearerToken = Effect.gen(function* () {
      const primary = yield* readPrimary;
      const environmentId = primary.descriptor.environmentId;
      const cached = Option.getOrUndefined(yield* credentials.get(environmentId));
      const saved = cached === undefined ? undefined : { kind: "bearer", token: cached.token };
      const grant = primary.credential;
      if (saved === undefined && grant === undefined) {
        // Without a credential the client can still reach an environment that
        // does not require authentication. It presents no bearer and receives
        // the anonymous session.
        if (primary.descriptor.auth.required) return Option.none<string>();
        return Option.some(ANONYMOUS_BEARER);
      }
      const credential = yield* authorizeConnectionCredential(primary.httpUrl, environmentId, saved ?? grant).pipe(
        Effect.catch((error) => {
          // Rust's in-memory sessions can disappear before their expiry when
          // the server restarts. Only rejection authorizes using a fresh grant;
          // permission and transient failures stay with the supervisor.
          if (error.reason !== "authentication") return Effect.fail(error);
          if (!primary.descriptor.auth.required) {
            // The environment no longer requires authentication, so a stale
            // credential must not block its anonymous session.
            return Effect.succeed(new BearerConnectionCredential({ token: ANONYMOUS_BEARER }));
          }
          if (saved === undefined || grant === undefined) return Effect.fail(error);
          return authorizeConnectionCredential(primary.httpUrl, environmentId, grant);
        }),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
      yield* credentials.put(environmentId, credential);
      return Option.some(credential.token);
    });
    return ClientCapabilities.PrimaryEnvironmentAuth.of({ bearerToken });
  });

/** Bearer sessions are validated; only bootstrap/pairing grants are exchanged. */
export const authorizeConnectionCredential = (
  httpUrl: string,
  environmentId: EnvironmentId,
  credential?: { readonly kind: string; readonly token: string },
) => Effect.gen(function* () {
  if (credential === undefined) {
    return yield* new ConnectionBlockedError({ reason: "authentication", detail: "A pairing token is required to add this environment." });
  }
  if (credential.kind === "bearer") {
    const session = yield* fetchRemoteSessionState({ httpBaseUrl: httpUrl, bearerToken: credential.token })
      .pipe(Effect.mapError(mapRemoteEnvironmentError));
    if (session.environmentId !== environmentId) {
      return yield* environmentMismatchError({ expected: environmentId, actual: session.environmentId });
    }
    return new BearerConnectionCredential({ token: credential.token, expiresAt: session.expiresAtUnixMs });
  }
  // The server grants bootstrap catalog management and limits pairing grants.
  // Downscoping both to Git operations prevents the desktop from opening repos.
  const exchanged = yield* bootstrapRemoteBearerSession({
    httpBaseUrl: httpUrl, credential: credential.token,
  }).pipe(Effect.mapError(mapRemoteEnvironmentError));
  return new BearerConnectionCredential({ token: exchanged.access_token, expiresAt: Date.now() + exchanged.expires_in * 1_000 });
});

/** The desktop shell owns SSH: it prepares the tunnel and pairs the session. */
const makeSshEnvironmentGateway = (options: WebConnectionOptions) =>
  Effect.gen(function* () {
    const desktop = options.desktop;
    const httpClient = yield* HttpClient.HttpClient;
    const prepare = (input: {
      readonly connectionId: string;
      readonly expectedEnvironmentId: EnvironmentId;
      readonly target: {
        readonly alias: string;
        readonly hostname: string;
        readonly username?: string;
        readonly port?: number;
        readonly identityFile?: string;
      };
      readonly bearerToken?: string;
    }) =>
      Effect.gen(function* () {
        if (!desktop) {
          return yield* new ConnectionBlockedError({
            reason: "configuration",
            detail: "SSH environments require the GitGui desktop app.",
          });
        }
        const prepared = yield* Effect.tryPromise({
          try: () => desktop.ensureSshConnection({
            kind: "ssh",
            host: input.target.hostname,
            ...(input.target.username === undefined ? {} : { user: input.target.username }),
            ...(input.target.port === undefined ? {} : { port: input.target.port }),
            ...(input.target.identityFile === undefined
              ? {}
              : { identityFile: input.target.identityFile }),
          }),
          catch: sshFailure,
        });
        const descriptor = yield* fetchDescriptor(prepared.httpUrl, options.fetchFn);
        if (descriptor.environmentId !== input.expectedEnvironmentId) {
          return yield* environmentMismatchError({ expected: input.expectedEnvironmentId, actual: descriptor.environmentId });
        }
        const saved = input.bearerToken === undefined ? undefined : { kind: "bearer", token: input.bearerToken };
        const credential = yield* authorizeConnectionCredential(prepared.httpUrl, input.expectedEnvironmentId, saved ?? prepared.credential).pipe(
          Effect.catch((error) => {
            // Restore an existing session whenever possible. A server restarted
            // without its session data can instead supply a fresh bootstrap grant.
            if (saved === undefined || prepared.credential === undefined || error.reason !== "authentication") {
              return Effect.fail(error);
            }
            return authorizeConnectionCredential(prepared.httpUrl, input.expectedEnvironmentId, prepared.credential);
          }),
        );
        return {
          bootstrap: {
            httpBaseUrl: prepared.httpUrl,
            wsBaseUrl: toWebSocketBaseUrl(prepared.httpUrl),
            environmentId: descriptor.environmentId as never,
          },
          bearerToken: credential.token,
        };
      }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));

    const disconnect: ClientCapabilities.SshEnvironmentGateway["Service"]["disconnect"] = (target) =>
      Effect.gen(function* () {
        if (!desktop) return;
        yield* Effect.tryPromise({
          try: () => desktop.disconnectSshConnection({
            kind: "ssh", host: target.hostname,
            ...(target.username === undefined ? {} : { user: target.username }),
            ...(target.port === undefined ? {} : { port: target.port }),
            ...(target.identityFile === undefined ? {} : { identityFile: target.identityFile }),
          }),
          catch: sshFailure,
        });
      });

    return ClientCapabilities.SshEnvironmentGateway.of({ prepare, disconnect });
  });

const makeConnectivity = () => {
  const changes = Stream.callback<"online" | "offline">((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const online = () => Queue.offerUnsafe(queue, "online");
        const offline = () => Queue.offerUnsafe(queue, "offline");
        window.addEventListener("online", online);
        window.addEventListener("offline", offline);
        return () => {
          window.removeEventListener("online", online);
          window.removeEventListener("offline", offline);
        };
      }),
      (release) => Effect.sync(release),
    ),
  );
  const status = Effect.sync<"online" | "offline">(() => (navigator.onLine ? "online" : "offline"));
  return Connectivity.layer({ status, changes });
};

const makeWakeups = (options: WebConnectionOptions) => {
  const changes = Stream.callback<ConnectionWakeups.ConnectionWakeup>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const focus = () => Queue.offerUnsafe(queue, "application-active");
        const visibility = () => {
          if (document.visibilityState === "visible") focus();
        };
        window.addEventListener("focus", focus);
        document.addEventListener("visibilitychange", visibility);
        const unsubscribeDesktop = options.desktop?.onApplicationWakeup(focus);
        return () => {
          window.removeEventListener("focus", focus);
          document.removeEventListener("visibilitychange", visibility);
          unsubscribeDesktop?.();
        };
      }),
      (release) => Effect.sync(release),
    ),
  );
  return ConnectionWakeups.layer({ changes });
};

export const discoverSshHosts = async (desktop: DesktopBridge | null): Promise<DesktopSshHost[]> =>
  desktop ? await desktop.discoverSshHosts() : [];

/**
 * The application's connection layer.
 *
 * The runtime's own layer provides the registry, the resolver, the driver, and
 * the RPC session. This layer adds the platform services it needs.
 */
export const webConnectionLayer = (options: WebConnectionOptions) => {
  const backend = createCatalogBackend(options);
  const layerPersistence = layerConnectionPersistence(backend);
  const readPrimary = readPrimaryEnvironment(options);
  const layerHttp = layerRemoteHttpClient(options.fetchFn);
  const layerPresentation = Layer.succeed(ClientCapabilities.ClientPresentation, {
    metadata: {
      surface: options.desktop ? "desktop" : "web",
      ...(options.appVersion === undefined ? {} : { appVersion: options.appVersion }),
      deviceType: "desktop",
    },
  });
  const layerSignals = Layer.mergeAll(makeConnectivity(), makeWakeups(options));
  const layerSource = Layer.effect(PlatformConnectionSource.PlatformConnectionSource, makePrimarySource(readPrimary))
    .pipe(Layer.provide(layerSignals));
  const layerPlatform = Layer.mergeAll(
    layerPresentation,
    Layer.effect(ClientCapabilities.PrimaryEnvironmentAuth, makePrimaryEnvironmentAuth(readPrimary)),
    Layer.effect(ClientCapabilities.SshEnvironmentGateway, makeSshEnvironmentGateway(options)),
    layerSource,
    Layer.succeed(EnvironmentOwnedDataCleanup, {
      clear: (environmentId) => Effect.promise(() =>
        new LocalStorageWorkspaceMetadataAdapter(options.storage).remove({ environmentId })),
    }),
    layerSignals,
  ).pipe(Layer.provideMerge(layerPersistence), Layer.provideMerge(layerHttp));
  const layerDependencies = Layer.mergeAll(layerPlatform, Socket.layerWebSocketConstructorGlobal);
  return Layer.provideMerge(connectionLayer, layerDependencies);
};

export type WebConnectionLayer = ReturnType<typeof webConnectionLayer>;
