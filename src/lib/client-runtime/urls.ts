export interface EndpointUrls {
  /** Base URL used for HTTP requests, without a trailing slash. */
  httpBaseUrl: string;
  /** WebSocket URL for the endpoint's `/ws` route. */
  wsUrl: string;
}

/** Query parameter shared by browser clients and the Rust WebSocket host. */
export const SESSION_TOKEN_QUERY_KEY = "session_token";

export function resolveEndpoint(endpoint: string | URL): EndpointUrls {
  const input = endpoint instanceof URL ? new URL(endpoint.href) : new URL(endpoint);
  if (input.username || input.password) {
    throw new TypeError("GitGui endpoints cannot contain credentials");
  }

  const protocol = input.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:" && protocol !== "ws:" && protocol !== "wss:") {
    throw new TypeError(`Unsupported GitGui endpoint protocol: ${input.protocol}`);
  }

  const http = new URL(input.href);
  http.protocol = protocol === "ws:" || protocol === "wss:" ? (protocol === "ws:" ? "http:" : "https:") : protocol;
  http.search = "";
  http.hash = "";
  http.pathname = http.pathname.replace(/\/+$/, "");

  const ws = new URL(http.href);
  ws.protocol = http.protocol === "https:" ? "wss:" : "ws:";

  return {
    httpBaseUrl: http.toString().replace(/\/$/, ""),
    wsUrl: joinUrl(ws.toString().replace(/\/$/, ""), "/ws"),
  };
}

export function toHttpUrl(endpoint: string | URL | EndpointUrls, path: string): string {
  const base = typeof endpoint === "object" && "httpBaseUrl" in endpoint
    ? endpoint.httpBaseUrl
    : resolveEndpoint(endpoint).httpBaseUrl;
  return joinUrl(base, path);
}

export function toWebSocketUrl(
  endpoint: string | URL | EndpointUrls,
  path = "/ws",
  sessionToken?: string,
): string {
  const base = typeof endpoint === "object" && "wsUrl" in endpoint
    ? endpoint.wsUrl.replace(/\/ws$/, "")
    : resolveEndpoint(endpoint).wsUrl.replace(/\/ws$/, "");
  const url = new URL(joinUrl(base, path));
  url.protocol = url.protocol === "https:" ? "wss:" : url.protocol === "http:" ? "ws:" : url.protocol;
  if (sessionToken !== undefined) {
    if (!sessionToken || /[\u0000-\u001f\u007f]/.test(sessionToken)) {
      throw new TypeError("sessionToken must be a non-empty string without control characters");
    }
    url.searchParams.set(SESSION_TOKEN_QUERY_KEY, sessionToken);
  }
  return url.toString();
}

function joinUrl(base: string, path: string): string {
  const normalizedBase = base.replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}
