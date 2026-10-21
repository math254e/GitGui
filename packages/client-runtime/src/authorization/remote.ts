/**
 * Vendored from T3 Code (`packages/client-runtime/src/authorization/remote.ts`).
 *
 * Upstream: t3code @ 1688f965682d331da16a8c39f049592361f69c8d
 * (`v0.1.2-nightly.20261021.3473`).
 *
 * Divergences from upstream:
 * - GitGui has no DPoP, so the DPoP token exchange, the DPoP WebSocket ticket,
 *   and the DPoP socket URL helpers are gone.
 * - GitGui has no cloud account, so the owner-hash parameters are gone; the
 *   remaining client presentation parameters are kept.
 * - The GitGui server exchanges a credential with a form-encoded `POST
 *   /oauth/token` request instead of an `HttpApi` group call.
 */
import {
  AuthSession,
  type ClientConnectionMethod,
  TokenExchangeResponse,
  WebSocketTicketResponse,
} from "@gitgui/contracts/environment";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";

import { environmentEndpointUrl } from "../environment/endpoint.ts";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpRequest,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";

export { RemoteEnvironmentAuthUndeclaredStatusError } from "../rpc/http.ts";
export type RemoteEnvironmentAuthError = RemoteEnvironmentRequestError;

const DEFAULT_REMOTE_REQUEST_TIMEOUT_MS = 10_000;

/** How the client presents itself to an environment. */
export interface ClientPresentationMetadata {
  readonly surface?: "web" | "desktop";
  readonly appVersion?: string;
  readonly deviceType?: "desktop" | "tablet" | "unknown";
  readonly os?: string;
}

export const appendClientConnectionParams = (
  url: URL,
  clientMetadata: ClientPresentationMetadata | undefined,
  connectionMethod?: ClientConnectionMethod,
): void => {
  if (clientMetadata?.surface) {
    url.searchParams.set("clientSurface", clientMetadata.surface);
  }
  if (clientMetadata?.appVersion) {
    url.searchParams.set("clientAppVersion", clientMetadata.appVersion);
  }
  if (clientMetadata?.deviceType) {
    url.searchParams.set("clientDeviceType", clientMetadata.deviceType);
  }
  if (clientMetadata?.os) {
    url.searchParams.set("clientOs", clientMetadata.os);
  }
  if (connectionMethod) {
    url.searchParams.set("connectionMethod", connectionMethod);
  }
};

/** Exchanges a bootstrap or pairing credential for a scoped bearer session. */
export const bootstrapRemoteBearerSession = Effect.fn(
  "clientRuntime.authorization.bootstrapRemoteBearerSession",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly credential: string;
  readonly scopes?: ReadonlyArray<string>;
  readonly clientMetadata?: ClientPresentationMetadata;
  readonly timeoutMs?: number;
}) {
  const body = new URLSearchParams({
    subject_token: input.credential,
    ...(input.scopes === undefined ? {} : { scope: input.scopes.join(" ") }),
  }).toString();
  const request = HttpClient.execute(
    makeEnvironmentHttpRequest({
      method: "POST",
      url: environmentEndpointUrl(input.httpBaseUrl, "/oauth/token"),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      contentType: "application/x-www-form-urlencoded",
    }),
  );
  return yield* executeEnvironmentHttpRequest(
    environmentEndpointUrl(input.httpBaseUrl, "/oauth/token"),
    input.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
    TokenExchangeResponse,
    request,
  );
});

export const fetchRemoteSessionState = Effect.fn(
  "clientRuntime.authorization.fetchRemoteSessionState",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
  readonly timeoutMs?: number;
}) {
  const request = HttpClient.execute(
    makeEnvironmentHttpRequest({
      method: "GET",
      url: environmentEndpointUrl(input.httpBaseUrl, "/api/auth/session"),
      headers: { authorization: `Bearer ${input.bearerToken}` },
    }),
  );
  return yield* executeEnvironmentHttpRequest(
    environmentEndpointUrl(input.httpBaseUrl, "/api/auth/session"),
    input.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
    AuthSession,
    request,
  );
});

export const issueRemoteWebSocketTicket = Effect.fn(
  "clientRuntime.authorization.issueRemoteWebSocketTicket",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
  readonly timeoutMs?: number;
}) {
  const request = HttpClient.execute(
    makeEnvironmentHttpRequest({
      method: "POST",
      url: environmentEndpointUrl(input.httpBaseUrl, "/api/auth/websocket-ticket"),
      headers: { authorization: `Bearer ${input.bearerToken}` },
    }),
  );
  return yield* executeEnvironmentHttpRequest(
    environmentEndpointUrl(input.httpBaseUrl, "/api/auth/websocket-ticket"),
    input.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
    WebSocketTicketResponse,
    request,
  );
});

export const resolveRemoteWebSocketConnectionUrl = Effect.fn(
  "clientRuntime.authorization.resolveRemoteWebSocketConnectionUrl",
)(function* (input: {
  readonly wsBaseUrl: string;
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
  readonly clientMetadata?: ClientPresentationMetadata;
  readonly connectionMethod?: ClientConnectionMethod;
  readonly timeoutMs?: number;
}) {
  const issued = yield* issueRemoteWebSocketTicket({
    httpBaseUrl: input.httpBaseUrl,
    bearerToken: input.bearerToken,
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
  });

  const url = new URL(input.wsBaseUrl);
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = "/ws";
  }
  url.searchParams.set("wsTicket", issued.ticket);
  appendClientConnectionParams(url, input.clientMetadata, input.connectionMethod);
  return url.toString();
});
