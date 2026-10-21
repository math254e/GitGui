/**
 * Vendored from T3 Code (`packages/client-runtime/src/environment/descriptor.ts`).
 *
 * Upstream: t3code @ 1688f965682d331da16a8c39f049592361f69c8d
 * (`v0.1.2-nightly.20261021.3473`).
 *
 * Divergences from upstream:
 * - T3 Code reads the descriptor from an `HttpApi` metadata group; GitGui
 *   serves `/.well-known/gitgui/environment` as plain JSON.
 */
import { EnvironmentDescriptor } from "@gitgui/contracts/environment";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";

import { environmentEndpointUrl } from "./endpoint.ts";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpRequest,
} from "../rpc/http.ts";

const DEFAULT_REMOTE_REQUEST_TIMEOUT_MS = 10_000;

export const ENVIRONMENT_DESCRIPTOR_PATH = "/.well-known/gitgui/environment";

export const fetchRemoteEnvironmentDescriptor = Effect.fn(
  "clientRuntime.environment.fetchRemoteEnvironmentDescriptor",
)(function* (input: { readonly httpBaseUrl: string; readonly timeoutMs?: number }) {
  const request = HttpClient.execute(
    makeEnvironmentHttpRequest({
      method: "GET",
      url: environmentEndpointUrl(input.httpBaseUrl, ENVIRONMENT_DESCRIPTOR_PATH),
    }),
  );
  return yield* executeEnvironmentHttpRequest(
    environmentEndpointUrl(input.httpBaseUrl, ENVIRONMENT_DESCRIPTOR_PATH),
    input.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
    EnvironmentDescriptor,
    request,
  );
});
