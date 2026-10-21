/**
 * Vendored from T3 Code (`packages/client-runtime/src/rpc/http.ts`).
 *
 * Upstream: t3code @ 1688f965682d331da16a8c39f049592361f69c8d
 * (`v0.1.2-nightly.20261021.3473`).
 *
 * Divergences from upstream:
 * - T3 Code talks to its own `HttpApi` groups; the GitGui server speaks plain
 *   JSON over a fixed REST surface, so the group client is replaced by a
 *   request/response helper that decodes one schema per endpoint.
 * - The request deadline includes success/error body decoding.
 * - Error bodies are schema-decoded; missing optional auth reasons are omitted.
 * - The `HttpObservability` layer from `@t3tools/shared` is not vendored.
 */
import {
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
  EnvironmentOperationForbiddenError,
  EnvironmentRequestInvalidError,
  EnvironmentResourceNotFoundError,
  EnvironmentScopeRequiredError,
  isEnvironmentHttpCommonError,
  type EnvironmentHttpCommonError,
} from "@gitgui/contracts/environment";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/http";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

export class RemoteEnvironmentAuthFetchError extends Data.TaggedError(
  "RemoteEnvironmentAuthFetchError",
)<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class RemoteEnvironmentAuthInvalidJsonError extends Data.TaggedError(
  "RemoteEnvironmentAuthInvalidJsonError",
)<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class RemoteEnvironmentAuthUndeclaredStatusError extends Data.TaggedError(
  "RemoteEnvironmentAuthUndeclaredStatusError",
)<{
  readonly message: string;
  readonly status: number;
  readonly requestUrl: string;
}> {
  constructor(requestUrl: string, status: number) {
    super({
      message: `Remote environment endpoint ${requestUrl} returned undeclared status ${status}.`,
      requestUrl,
      status,
    });
  }
}

export class RemoteEnvironmentAuthTimeoutError extends Data.TaggedError(
  "RemoteEnvironmentAuthTimeoutError",
)<{
  readonly message: string;
  readonly requestUrl: string;
  readonly timeoutMs: number;
}> {
  constructor(requestUrl: string, timeoutMs: number) {
    super({
      message: `Remote environment endpoint ${requestUrl} timed out after ${timeoutMs}ms.`,
      requestUrl,
      timeoutMs,
    });
  }
}

export type RemoteEnvironmentRequestError =
  | EnvironmentHttpCommonError
  | RemoteEnvironmentAuthFetchError
  | RemoteEnvironmentAuthInvalidJsonError
  | RemoteEnvironmentAuthUndeclaredStatusError
  | RemoteEnvironmentAuthTimeoutError;

export const layerRemoteHttpClient = (
  fetchFn: typeof globalThis.fetch,
): Layer.Layer<HttpClient.HttpClient> =>
  FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn)));

/** The error body the GitGui server returns for a rejected HTTP request. */
export const GitGuiErrorResponse = Schema.Struct({
  error: Schema.String,
  message: Schema.String,
});
export type GitGuiErrorResponse = typeof GitGuiErrorResponse.Type;

export const remoteApiBaseUrl = (httpBaseUrl: string): string => {
  const url = new URL(httpBaseUrl);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
};

export interface EnvironmentHttpRequest {
  readonly method?: "GET" | "POST";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** A form-encoded or JSON body, already serialized. */
  readonly body?: string;
  readonly contentType?: string;
}

export const makeEnvironmentHttpRequest = (
  input: EnvironmentHttpRequest,
): HttpClientRequest.HttpClientRequest => {
  const request = HttpClientRequest.make(input.method ?? "GET")(input.url);
  const withHeaders = input.headers === undefined
    ? request
    : HttpClientRequest.setHeaders(request, input.headers);
  if (input.body === undefined) {
    return withHeaders;
  }
  return HttpClientRequest.setBody(
    withHeaders,
    HttpBody.text(input.body, input.contentType ?? "application/json"),
  );
};

/**
 * The GitGui server answers a rejected request with a status and an
 * `{ error, message }` body. Map that onto the typed environment errors so
 * the connection runtime can tell a blocked credential from an unreachable
 * host.
 */
export const mapGitGuiErrorStatus = (
  status: number,
  body: GitGuiErrorResponse | null,
): EnvironmentHttpCommonError => {
  const message = body?.message ?? `The environment returned HTTP ${status}.`;
  switch (status) {
    case 400:
      return body?.error === "invalid_scope"
        ? new EnvironmentScopeRequiredError({ scope: body.message, message })
        : new EnvironmentRequestInvalidError({ message });
    case 401:
    case 403:
      return status === 403
        ? new EnvironmentOperationForbiddenError({ message })
        : new EnvironmentAuthInvalidError({ ...(body?.error === undefined ? {} : { reason: body.error }), message });
    case 404:
      return new EnvironmentResourceNotFoundError({ message });
    default:
      return new EnvironmentInternalError({ message });
  }
};

const decodeErrorBody = (
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<GitGuiErrorResponse | null> =>
  response.json.pipe(
    Effect.map((body) => Option.getOrNull(Schema.decodeUnknownOption(GitGuiErrorResponse)(body))),
    Effect.catch(() => Effect.succeed(null)),
  );

/**
 * Runs one environment HTTP request and decodes its JSON body.
 *
 * T3 Code decodes through `HttpApi`; the GitGui server speaks plain JSON, so
 * the endpoint's schema is passed in here instead.
 */
export const executeEnvironmentHttpRequest = <S extends Schema.Top>(
  requestUrl: string,
  timeoutMs: number,
  schema: S,
  request: Effect.Effect<
    HttpClientResponse.HttpClientResponse,
    HttpClientError.HttpClientError,
    HttpClient.HttpClient
  >,
): Effect.Effect<
  S["Type"],
  RemoteEnvironmentRequestError,
  HttpClient.HttpClient | S["DecodingServices"]
> =>
  request.pipe(
    Effect.flatMap((response) =>
      Effect.gen(function* () {
        if (response.status < 200 || response.status >= 300) {
          const body = yield* decodeErrorBody(response);
          return yield* Effect.fail(mapGitGuiErrorStatus(response.status, body));
        }
        const raw = yield* response.json.pipe(
          Effect.catch((cause) =>
            Effect.fail(
              new RemoteEnvironmentAuthInvalidJsonError({
                message: `Remote environment endpoint returned an invalid response from ${requestUrl}.`,
                cause,
              }),
            ),
          ),
        );
        return yield* Schema.decodeUnknownEffect(schema)(raw).pipe(
          Effect.mapError(
            (cause) =>
              new RemoteEnvironmentAuthInvalidJsonError({
                message: `Remote environment endpoint returned an invalid response from ${requestUrl}.`,
                cause,
              }),
          ),
        );
      }),
    ),
    Effect.timeoutOption(Duration.millis(timeoutMs)),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new RemoteEnvironmentAuthTimeoutError(requestUrl, timeoutMs)),
        onSome: Effect.succeed,
      }),
    ),
    Effect.catch((cause) => failRemoteRequest(requestUrl, cause)),
  );

const failRemoteRequest = (
  requestUrl: string,
  cause: unknown,
): Effect.Effect<never, RemoteEnvironmentRequestError> => {
  if (cause instanceof RemoteEnvironmentAuthTimeoutError) {
    return Effect.fail(cause);
  }
  if (isEnvironmentHttpCommonError(cause)) {
    return Effect.fail(cause);
  }
  if (Schema.isSchemaError(cause)) {
    return Effect.fail(
      new RemoteEnvironmentAuthInvalidJsonError({
        message: `Remote environment endpoint returned an invalid response from ${requestUrl}.`,
        cause,
      }),
    );
  }
  if (HttpClientError.isHttpClientError(cause) && cause.response !== undefined) {
    const response = cause.response;
    if (response.status < 200 || response.status >= 300) {
      return Effect.fail(
        new RemoteEnvironmentAuthUndeclaredStatusError(requestUrl, response.status),
      );
    }
    return Effect.fail(
      new RemoteEnvironmentAuthInvalidJsonError({
        message: `Remote environment endpoint returned an invalid response from ${requestUrl}.`,
        cause,
      }),
    );
  }
  return Effect.fail(
    new RemoteEnvironmentAuthFetchError({
      message: `Failed to fetch remote environment endpoint ${requestUrl} (${String(cause)}).`,
      cause,
    }),
  );
};
