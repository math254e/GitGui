/**
 * Effect Schema contracts for the GitGui environment surface.
 *
 * These mirror the Rust definitions in `crates/gitgui-protocol/src/lib.rs`.
 * The generated `protocol.ts` keeps the wire shapes; this module adds the
 * branded identifiers and error types the client runtime needs, so the
 * connection runtime can use the same Effect conventions as T3 Code.
 */
import * as Schema from "effect/Schema";

const isNonBlank = Schema.makeFilter((value: string) => value.trim().length > 0, {
  expected: "a non-blank string",
  toJsonSchema: () => [{ minLength: 1 }, true],
  arbitraryConstraint: { minLength: 1 },
});

export const TrimmedNonEmptyString = Schema.Trimmed.check(isNonBlank);

export const EnvironmentId = TrimmedNonEmptyString.pipe(
  Schema.brand<"EnvironmentId">("EnvironmentId"),
);
export type EnvironmentId = typeof EnvironmentId.Type;

/** How a client reached an environment. */
export const ClientConnectionMethod = Schema.Literals(["direct", "ssh", "unknown"]);
export type ClientConnectionMethod = typeof ClientConnectionMethod.Type;

/** GitGui protocol version understood by the client. */
export const PROTOCOL_VERSION = 2;

/** One candidate route an environment advertises. */
export const AdvertisedEndpoint = Schema.Struct({
  key: Schema.String,
  httpUrl: Schema.String,
  websocketUrl: Schema.String,
  isDefault: Schema.Boolean,
  reachability: Schema.String,
});
export type AdvertisedEndpoint = typeof AdvertisedEndpoint.Type;

/** Authentication capabilities an environment advertises before a client connects. */
export const EnvironmentAuthPolicy = Schema.Struct({
  required: Schema.Boolean,
  bootstrapMethods: Schema.Array(Schema.String),
  sessionMethods: Schema.Array(Schema.String),
});
export type EnvironmentAuthPolicy = typeof EnvironmentAuthPolicy.Type;

/** Stable, versioned description of one running backend environment. */
export const EnvironmentDescriptor = Schema.Struct({
  schemaVersion: Schema.Number,
  environmentId: EnvironmentId,
  label: Schema.String,
  serverVersion: Schema.String,
  protocolVersion: Schema.Number,
  platform: Schema.String,
  architecture: Schema.String,
  capabilities: Schema.Array(Schema.String),
  auth: EnvironmentAuthPolicy,
  endpoints: Schema.Array(AdvertisedEndpoint),
});
export type EnvironmentDescriptor = typeof EnvironmentDescriptor.Type;

/** Safe information about the current authenticated session. */
export const AuthSession = Schema.Struct({
  sessionId: Schema.String,
  environmentId: EnvironmentId,
  scopes: Schema.Array(Schema.String),
  expiresAtUnixMs: Schema.Number,
});
export type AuthSession = typeof AuthSession.Type;

/** OAuth-shaped token exchange response. */
export const TokenExchangeResponse = Schema.Struct({
  access_token: Schema.String,
  issued_token_type: Schema.String,
  token_type: Schema.String,
  expires_in: Schema.Number,
  scope: Schema.String,
});
export type TokenExchangeResponse = typeof TokenExchangeResponse.Type;

/** A short-lived single-use credential for the WebSocket handshake. */
export const WebSocketTicketResponse = Schema.Struct({
  ticket: Schema.String,
  expiresIn: Schema.Number,
});
export type WebSocketTicketResponse = typeof WebSocketTicketResponse.Type;

/** A one-time credential that can create an ordinary client session. */
export const PairingCredentialResponse = Schema.Struct({
  credential: Schema.String,
  expiresIn: Schema.Number,
});
export type PairingCredentialResponse = typeof PairingCredentialResponse.Type;

/** One SSH host the desktop shell can reach. */
export const SshEnvironmentTarget = Schema.Struct({
  alias: Schema.String,
  hostname: Schema.String,
  username: Schema.optionalKey(Schema.String),
  port: Schema.optionalKey(Schema.Number),
  identityFile: Schema.optionalKey(Schema.String),
});
export type SshEnvironmentTarget = typeof SshEnvironmentTarget.Type;

/** Scopes the client runtime asks for when it exchanges a credential. */
export const AUTH_SCOPES = ["repository:read", "repository:operate"] as const;

/** The environment denied the request because the session lacks a scope. */
export class EnvironmentScopeRequiredError extends Schema.TaggedError<EnvironmentScopeRequiredError>()(
  "EnvironmentScopeRequiredError",
  {
    scope: Schema.String,
    message: Schema.String,
    traceId: Schema.optionalKey(Schema.String),
  },
) {}

/** The environment denied the request because the session may not do it. */
export class EnvironmentOperationForbiddenError extends Schema.TaggedError<EnvironmentOperationForbiddenError>()(
  "EnvironmentOperationForbiddenError",
  {
    message: Schema.String,
    traceId: Schema.optionalKey(Schema.String),
  },
) {}

/** The credential presented to the environment was rejected. */
export class EnvironmentAuthInvalidError extends Schema.TaggedError<EnvironmentAuthInvalidError>()(
  "EnvironmentAuthInvalidError",
  {
    reason: Schema.optionalKey(Schema.String),
    message: Schema.String,
    traceId: Schema.optionalKey(Schema.String),
  },
) {}

/** The environment could not answer a valid request. */
export class EnvironmentInternalError extends Schema.TaggedError<EnvironmentInternalError>()(
  "EnvironmentInternalError",
  {
    message: Schema.String,
    traceId: Schema.optionalKey(Schema.String),
  },
) {}

/** The environment rejected the request shape. */
export class EnvironmentRequestInvalidError extends Schema.TaggedError<EnvironmentRequestInvalidError>()(
  "EnvironmentRequestInvalidError",
  {
    message: Schema.String,
    traceId: Schema.optionalKey(Schema.String),
  },
) {}

/** The requested environment resource does not exist. */
export class EnvironmentResourceNotFoundError extends Schema.TaggedError<EnvironmentResourceNotFoundError>()(
  "EnvironmentResourceNotFoundError",
  {
    message: Schema.String,
    traceId: Schema.optionalKey(Schema.String),
  },
) {}

/** Every error the environment HTTP surface can return. */
export const EnvironmentHttpCommonError = Schema.Union([
  EnvironmentAuthInvalidError,
  EnvironmentScopeRequiredError,
  EnvironmentOperationForbiddenError,
  EnvironmentRequestInvalidError,
  EnvironmentResourceNotFoundError,
  EnvironmentInternalError,
]);
export type EnvironmentHttpCommonError = typeof EnvironmentHttpCommonError.Type;

export const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);
