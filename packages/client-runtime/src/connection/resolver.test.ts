import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionPlatform, ConnectionRegistration, RuntimeWakeup } from "./model";
import { ConnectionResolver } from "./resolver";
import { MemoryCredentialStore } from "./stores";

afterEach(() => vi.unstubAllGlobals());

describe("ConnectionResolver", () => {
  it("prefers the freshly prepared primary credential over a stale persisted bootstrap", async () => {
    const environmentId = "00000000-0000-4000-8000-000000000001";
    const credentials = new MemoryCredentialStore();
    await credentials.set(environmentId, { kind: "bootstrap", token: "stale-bootstrap" });

    const exchangedCredentials: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/oauth/token")) {
        const body = init?.body as URLSearchParams;
        const credential = body.get("subject_token") ?? "";
        exchangedCredentials.push(credential);
        if (credential !== "fresh-bootstrap") return new Response("unauthorized", { status: 401 });
        return Response.json({
          access_token: "fresh-bearer",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "git:read",
        });
      }
      if (url.endsWith("/api/auth/websocket-ticket")) {
        return Response.json({ ticket: "fresh-ticket", expires_in: 300 });
      }
      return new Response("not found", { status: 404 });
    }));

    const platform: ConnectionPlatform = {
      isOnline: () => true,
      subscribeNetwork: () => () => undefined,
      subscribeWakeups: (_listener: (reason: RuntimeWakeup) => void) => () => undefined,
      async getPrimaryConnection() {
        return {
          httpUrl: "http://127.0.0.1:3774",
          descriptor: descriptor(environmentId),
          credential: { kind: "bootstrap" as const, token: "fresh-bootstrap" },
        };
      },
      async ensureSshConnection() { throw new Error("not used"); },
    };
    const registration: ConnectionRegistration = {
      environmentId,
      displayName: "Primary",
      target: { kind: "primary" },
      capabilities: [],
      protocolVersion: 2,
    };

    const connection = await new ConnectionResolver(platform, credentials)
      .resolve(registration, new AbortController().signal);

    expect(exchangedCredentials).toEqual(["fresh-bootstrap"]);
    expect(connection.accessToken).toBe("fresh-bearer");
    expect(connection.websocketTicket).toBe("fresh-ticket");
    expect(await credentials.get(environmentId)).toMatchObject({
      kind: "bearer",
      token: "fresh-bearer",
    });
  });
});

function descriptor(environmentId: string) {
  return {
    schemaVersion: 1,
    environmentId,
    label: "Primary",
    serverVersion: "0.1.0",
    protocolVersion: 2,
    platform: "test",
    architecture: "test",
    capabilities: [],
    auth: {
      required: true,
      bootstrapMethods: ["token-exchange"],
      sessionMethods: ["bearer-access-token", "websocket-ticket"],
    },
    endpoints: [],
  };
}
