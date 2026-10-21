import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import { fetchRemoteSessionState } from "../authorization/remote.ts";
import { mapRemoteEnvironmentError } from "../connection/errors.ts";
import { layerRemoteHttpClient, mapGitGuiErrorStatus } from "./http.ts";

describe("HTTP failures outside the GitGui error envelope", () => {
  it("omits absent auth reasons for a bodyless 401", () => {
    const error = mapGitGuiErrorStatus(401, null);
    expect(error._tag).toBe("EnvironmentAuthInvalidError");
    expect(error).not.toHaveProperty("reason");
    expect(mapRemoteEnvironmentError(error)).toMatchObject({ reason: "authentication" });
  });

  for (const [label, body] of [
    ["empty", null], ["HTML", "<html>Unauthorized</html>"],
    ["missing error code", JSON.stringify({ message: "Expired" })],
    ["wrong field types", JSON.stringify({ error: 401, message: {} })],
  ] as const) {
    it.effect(`classifies a 401 with ${label} response content`, () =>
      fetchRemoteSessionState({ httpBaseUrl: "https://example.test", bearerToken: "test-session" }).pipe(
        Effect.mapError(mapRemoteEnvironmentError),
        Effect.flip,
        Effect.tap((error) => Effect.sync(() => {
          expect(error).toMatchObject({ _tag: "ConnectionBlockedError", reason: "authentication" });
        })),
        Effect.provide(layerRemoteHttpClient(async () => new Response(body, { status: 401 }))),
      ));
  }
});


describe("HTTP request deadlines", () => {
  it.each([200, 401])("times out an incomplete HTTP %s body and permits the next discovery", async (status) => {
    let requests = 0;
    let stalledResponseClosed!: () => void;
    const closed = new Promise<void>((resolve) => { stalledResponseClosed = resolve; });
    const descriptor = {
      schemaVersion: 1, environmentId: "test-environment", label: "Test", serverVersion: "0.1.0", protocolVersion: 2,
      platform: "linux", architecture: "x64", capabilities: [], endpoints: [],
      auth: { required: true, bootstrapMethods: ["pairing"], sessionMethods: ["bearer"] },
    };
    const server = createServer((_request, response) => {
      if (++requests === 1) {
        response.on("close", stalledResponseClosed);
        response.writeHead(status, { "content-type": "application/json" });
        response.flushHeaders();
        response.write("{");
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(descriptor));
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("The HTTP fixture did not bind a port.");
      const httpBaseUrl = `http://127.0.0.1:${address.port}`;
      const result = await Effect.runPromise(fetchRemoteEnvironmentDescriptor({ httpBaseUrl, timeoutMs: 100 }).pipe(
        Effect.flip, Effect.timeoutOption("1 second"), Effect.provide(layerRemoteHttpClient(fetch)),
      ));
      expect(Option.getOrThrow(result)).toMatchObject({ _tag: "RemoteEnvironmentAuthTimeoutError", timeoutMs: 100 });
      // Interruption must abort the body read, not leave a socket behind.
      const aborted = await Effect.runPromise(Effect.promise(() => closed).pipe(Effect.timeoutOption("1 second")));
      expect(Option.isSome(aborted)).toBe(true);
      const next = await Effect.runPromise(fetchRemoteEnvironmentDescriptor({ httpBaseUrl, timeoutMs: 1000 }).pipe(
        Effect.provide(layerRemoteHttpClient(fetch)),
      ));
      expect(next.environmentId).toBe("test-environment");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
