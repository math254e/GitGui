/**
 * Vendored from T3 Code (`packages/client-runtime/src/connection/routes.test.ts`).
 *
 * Upstream: t3code @ 1688f965682d331da16a8c39f049592361f69c8d
 * (`v0.1.2-nightly.20261021.3473`).
 *
 * Divergences from upstream:
 * - The T3 Connect route and the GitHub routing trust cases are gone: GitGui
 *   has no relay and no source-control routing.
 */
import { EnvironmentId } from "@gitgui/contracts/environment";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import {
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  type ConnectionRoute,
} from "./catalog.ts";
import { BearerConnectionTarget } from "./model.ts";
import {
  connectionRouteId,
  connectionRouteKind,
  connectionRouteLabel,
  credentialConnectionId,
  insertRoute,
  mergeLearnedRoutes,
  routesAfterRemoving,
  sendsTokenInClear,
  upsertRoute,
  usableRoutes,
} from "./routes.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

function direct(id: string, httpBaseUrl: string): ConnectionRoute {
  return {
    target: new BearerConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      label: "Desk",
      connectionId: id,
    }),
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId: id,
        environmentId: ENVIRONMENT_ID,
        label: "Desk",
        httpBaseUrl,
        wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
      }),
    ),
  };
}

const LAN = direct("lan", "http://192.168.1.10:3773/");
const TAILNET = direct("tailnet", "https://desk.tail1234.ts.net/");
const PUBLIC = direct("public", "https://desk.example.com/");

function learned(id: string, httpBaseUrl: string): ConnectionRoute {
  const route = direct(id, httpBaseUrl);
  const profile = Option.getOrThrow(route.profile) as BearerConnectionProfile;
  return {
    target: route.target,
    profile: Option.some(new BearerConnectionProfile({ ...profile, learned: true })),
  };
}

describe("connection routes", () => {
  it("classifies direct routes by address", () => {
    expect(connectionRouteKind(LAN)).toBe("lan");
    // Tailscale, Cloudflare WARP and Mesh, and other VPNs share 100.64.0.0/10.
    expect(connectionRouteKind(direct("ip", "http://100.101.102.103:3773/"))).toBe("vpn");
    expect(connectionRouteLabel(direct("mesh", "http://100.96.0.1:3773/"))).toBe("VPN");
    expect(connectionRouteKind(TAILNET)).toBe("tailnet");
    expect(connectionRouteKind(PUBLIC)).toBe("public");
    expect(connectionRouteKind(direct("lo", "http://127.0.0.1:3773/"))).toBe("loopback");
    expect(connectionRouteKind(direct("ts6", "http://[fd7a:115c:a1e0::1]:3773/"))).toBe("tailnet");
    expect(connectionRouteLabel(TAILNET)).toBe("Tailscale");
  });

  it("places a new route after faster kinds", () => {
    expect(insertRoute([TAILNET], LAN)).toEqual([LAN, TAILNET]);
    expect(insertRoute([LAN, TAILNET], PUBLIC)).toEqual([LAN, TAILNET, PUBLIC]);
  });

  it("keeps a user's order when a saved route is replaced", () => {
    const repaired = direct("lan", "http://192.168.1.11:3773/");
    expect(upsertRoute([TAILNET, LAN], repaired)).toEqual([TAILNET, repaired]);
  });
});

describe("learned routes", () => {
  const bearerOnly: ConnectionCatalogEntry = {
    target: LAN.target,
    profile: LAN.profile,
    enabled: true,
  };
  const ids = (routes: ReadonlyArray<ConnectionRoute> | null) =>
    routes?.map((route) => connectionRouteId(route.target)) ?? null;
  const profileOf = (route: ConnectionRoute) => Option.getOrThrow(route.profile);

  it("learns a LAN address the server reports, borrowing the paired token", () => {
    const routes = mergeLearnedRoutes({
      entry: bearerOnly,
      activeRoute: LAN,
      reported: [{ httpBaseUrl: "http://192.168.1.11:3773/" }],
      allowInsecure: true,
    });
    expect(ids(routes)).toEqual([
      "lan",
      `learned:${ENVIRONMENT_ID}:http://192.168.1.11:3773@lan`,
    ]);
    expect(profileOf(routes![1]!)).toMatchObject({
      learned: true,
      wsBaseUrl: "ws://192.168.1.11:3773/",
    });
  });

  it("labels a learned address Tailscale only while the server reports it as tailnet", () => {
    const routes = mergeLearnedRoutes({
      entry: bearerOnly,
      activeRoute: LAN,
      reported: [{ httpBaseUrl: "http://desk.tail1234.ts.net:3773/", kind: "tailnet" }],
      allowInsecure: true,
    });
    const learnedRoute = routes!.find((route) =>
      connectionRouteId(route.target).startsWith("learned:"),
    );
    expect(profileOf(learnedRoute!)).toMatchObject({ network: "tailscale" });
  });

  it("never learns a loopback address", () => {
    const routes = mergeLearnedRoutes({
      entry: bearerOnly,
      activeRoute: LAN,
      reported: [{ httpBaseUrl: "http://127.0.0.1:3773/" }],
      allowInsecure: true,
    });
    expect(routes).toBeNull();
  });

  it("skips plain HTTP from an HTTPS page", () => {
    const routes = mergeLearnedRoutes({
      entry: bearerOnly,
      activeRoute: LAN,
      reported: [{ httpBaseUrl: "http://192.168.1.12:3773/" }],
      allowInsecure: false,
    });
    expect(routes).toBeNull();
  });

  it("keeps a token paired over HTTPS off plain HTTP addresses outside the tailnet", () => {
    const httpsRoute = direct("secure", "https://desk.example.com/");
    const borrowed = learned("learned:x@secure", "http://192.168.1.13:3773/");
    expect(sendsTokenInClear([httpsRoute, borrowed], borrowed)).toBe(true);
    expect(
      usableRoutes({
        target: httpsRoute.target,
        profile: httpsRoute.profile,
        alternateRoutes: [borrowed],
        enabled: true,
      }),
    ).toEqual([httpsRoute]);
  });

  it("removes learned routes along with the route whose credential they borrow", () => {
    const learnedRoute = learned("learned:x@lan", "http://192.168.1.14:3773/");
    expect(credentialConnectionId("learned:x@lan")).toBe("lan");
    expect(routesAfterRemoving([LAN, learnedRoute], "lan")).toEqual([]);
  });
});
