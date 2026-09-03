import type {
  AuthSession,
  EnvironmentDescriptor,
  TokenExchangeResponse,
  WebSocketTicketResponse,
} from "@gitgui/contracts";
import { resolveEndpoint } from "../rpc/urls";
import type {
  ConnectionCredential,
  ConnectionPlatform,
  ConnectionRegistration,
  CredentialStore,
  PlatformPreparedConnection,
  PreparedConnection,
} from "./model";
import { ConnectionFailure } from "./model";

export const EXPECTED_PROTOCOL_VERSION = 2;

export class ConnectionResolver {
  constructor(
    private readonly platform: ConnectionPlatform,
    private readonly credentials: CredentialStore,
  ) {}

  async resolve(registration: ConnectionRegistration, signal: AbortSignal): Promise<PreparedConnection> {
    let platformConnection: PlatformPreparedConnection;
    switch (registration.target.kind) {
      case "primary": {
        const primary = await this.platform.getPrimaryConnection(signal);
        if (!primary) throw new ConnectionFailure("The primary GitGui backend is unavailable", "configuration", false);
        platformConnection = primary;
        break;
      }
      case "bearer":
        platformConnection = {
          httpUrl: registration.target.httpUrl,
          descriptor: await discoverEnvironment(registration.target.httpUrl, signal),
        };
        break;
      case "ssh":
        platformConnection = await this.platform.ensureSshConnection(registration.target, signal);
        break;
    }

    const descriptor = validateDescriptor(platformConnection.descriptor);
    if (descriptor.environmentId !== registration.environmentId) {
      throw new ConnectionFailure(
        `Connection resolved to environment ${descriptor.environmentId}, expected ${registration.environmentId}`,
        "configuration",
        false,
      );
    }

    const storedCredential = await this.credentials.get(registration.environmentId);
    // A prepared platform connection can carry a credential tied to the
    // backend process or SSH bridge that was just resolved. Prefer it over a
    // persisted credential, which may belong to an earlier process lifetime.
    const candidates = [platformConnection.credential, storedCredential].filter(
      (value): value is ConnectionCredential => value !== undefined,
    );
    return authorizeConnection(
      { ...platformConnection, descriptor },
      candidates,
      this.credentials,
      signal,
    );
  }
}

export async function discoverEnvironment(httpUrl: string, signal?: AbortSignal): Promise<EnvironmentDescriptor> {
  const endpoint = resolveEndpoint(httpUrl);
  let response: Response;
  try {
    response = await fetch(`${endpoint.httpBaseUrl}/.well-known/gitgui/environment`, { signal });
  } catch (error) {
    throw networkFailure("Could not discover the GitGui environment", error);
  }
  if (!response.ok) {
    throw httpFailure(response.status, "GitGui environment discovery failed");
  }
  try {
    return validateDescriptor(await response.json());
  } catch (error) {
    if (error instanceof ConnectionFailure) throw error;
    throw new ConnectionFailure("The server returned an invalid environment descriptor", "protocol", false, { cause: error });
  }
}

async function authorizeConnection(
  connection: PlatformPreparedConnection,
  candidates: ConnectionCredential[],
  store: CredentialStore,
  signal: AbortSignal,
): Promise<PreparedConnection> {
  const httpUrl = resolveEndpoint(connection.httpUrl).httpBaseUrl;
  if (!connection.descriptor.auth.required) return { ...connection, httpUrl };

  let bearer = candidates.find((candidate) => candidate.kind === "bearer");
  if (bearer?.kind === "bearer") {
    try {
      await inspectSession(httpUrl, bearer.token, signal);
    } catch (error) {
      if (!(error instanceof ConnectionFailure) || error.kind !== "authentication") throw error;
      bearer = undefined;
    }
  }

  if (!bearer) {
    const exchangeable = candidates.find(
      (candidate) => candidate.kind === "bootstrap" || candidate.kind === "pairing",
    );
    if (!exchangeable) {
      throw new ConnectionFailure("This GitGui environment requires pairing or a valid credential", "authentication", false);
    }
    const exchanged = await exchangeCredential(httpUrl, exchangeable.token, signal);
    bearer = {
      kind: "bearer",
      token: exchanged.access_token,
      expiresAt: Date.now() + exchanged.expires_in * 1000,
    };
    await store.set(connection.descriptor.environmentId, bearer);
  }

  const websocketTicket = await issueWebSocketTicket(httpUrl, bearer.token, signal);
  return {
    ...connection,
    httpUrl,
    credential: bearer,
    accessToken: bearer.token,
    websocketTicket: websocketTicket.ticket,
  };
}

async function exchangeCredential(httpUrl: string, credential: string, signal: AbortSignal) {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: credential,
    subject_token_type: "urn:gitgui:params:oauth:token-type:environment-bootstrap",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
  });
  const response = await safeFetch(`${httpUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal,
  });
  if (!response.ok) throw httpFailure(response.status, "GitGui credential exchange failed");
  return (await response.json()) as TokenExchangeResponse;
}

async function inspectSession(httpUrl: string, token: string, signal: AbortSignal) {
  const response = await safeFetch(`${httpUrl}/api/auth/session`, {
    headers: { authorization: `Bearer ${token}` },
    signal,
  });
  if (!response.ok) throw httpFailure(response.status, "GitGui session validation failed");
  return (await response.json()) as AuthSession;
}

async function issueWebSocketTicket(httpUrl: string, token: string, signal: AbortSignal) {
  const response = await safeFetch(`${httpUrl}/api/auth/websocket-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal,
  });
  if (!response.ok) throw httpFailure(response.status, "GitGui WebSocket authorization failed");
  return (await response.json()) as WebSocketTicketResponse;
}

async function safeFetch(url: string, init: RequestInit) {
  try {
    return await fetch(url, init);
  } catch (error) {
    throw networkFailure("Could not reach the GitGui environment", error);
  }
}

function validateDescriptor(value: unknown): EnvironmentDescriptor {
  if (!isRecord(value) || typeof value.environmentId !== "string" || !value.environmentId) {
    throw new ConnectionFailure("The server did not provide a stable EnvironmentId", "protocol", false);
  }
  if (value.protocolVersion !== EXPECTED_PROTOCOL_VERSION) {
    throw new ConnectionFailure(
      `GitGui protocol ${String(value.protocolVersion)} is incompatible with ${EXPECTED_PROTOCOL_VERSION}`,
      "unsupported",
      false,
    );
  }
  if (!isRecord(value.auth) || typeof value.auth.required !== "boolean") {
    throw new ConnectionFailure("The server descriptor has no valid authentication policy", "protocol", false);
  }
  return value as unknown as EnvironmentDescriptor;
}

function httpFailure(status: number, message: string): ConnectionFailure {
  if (status === 401) return new ConnectionFailure(message, "authentication", false);
  if (status === 403) return new ConnectionFailure(message, "permission", false);
  if (status >= 500 || status === 408 || status === 429) return new ConnectionFailure(message, "network", true);
  return new ConnectionFailure(`${message} (HTTP ${status})`, "protocol", false);
}

function networkFailure(message: string, cause: unknown): ConnectionFailure {
  if (cause instanceof DOMException && cause.name === "AbortError") {
    return new ConnectionFailure("Connection attempt cancelled", "network", true, { cause });
  }
  return new ConnectionFailure(message, "network", true, { cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
