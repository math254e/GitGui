import { describe, expect, it } from "vitest";
import {
  isSettingsRouteId,
  repositoryIdFromParam,
  repositoryPath,
  scopedRepositoryPath,
  settingsPath,
  repositoryRouteFromParams,
  isRepositoryRouteId,
  REPOSITORY_ROUTE_ID,
  SCOPED_REPOSITORY_ROUTE_ID,
} from "./routes";

describe("route paths", () => {
  it("builds a repository path from a server-issued identifier", () => {
    expect(repositoryPath("repo-4f1a5a9c10c8f782")).toBe("/repo/repo-4f1a5a9c10c8f782");
  });

  it("escapes identifiers that would otherwise change the path", () => {
    expect(repositoryPath("repo/../settings")).toBe("/repo/repo%2F..%2Fsettings");
    expect(scopedRepositoryPath("host/one", "repo/../settings")).toBe("/repo/host%2Fone/repo%2F..%2Fsettings");
  });

  it("builds settings paths from a section name", () => {
    expect(settingsPath("general")).toBe("/settings/general");
    expect(settingsPath("appearance")).toBe("/settings/appearance");
    expect(settingsPath("connections")).toBe("/settings/connections");
  });

  it("recognizes and decodes the mounted route IDs without selected-environment inference", () => {
    expect(isRepositoryRouteId(REPOSITORY_ROUTE_ID)).toBe(true);
    expect(isRepositoryRouteId(SCOPED_REPOSITORY_ROUTE_ID)).toBe(true);
    expect(isRepositoryRouteId("/")).toBe(false);
    expect(isRepositoryRouteId(null)).toBe(false);
    expect(repositoryRouteFromParams(REPOSITORY_ROUTE_ID, { repositoryId: "same", environmentId: "ignored" }))
      .toEqual({ kind: "legacy", repositoryId: "same" });
    expect(repositoryRouteFromParams(SCOPED_REPOSITORY_ROUTE_ID, { environmentId: "host/one", repositoryId: "repo%two" }))
      .toEqual({ kind: "scoped", target: { environmentId: "host/one", repositoryId: "repo%two" } });
    expect(repositoryRouteFromParams(SCOPED_REPOSITORY_ROUTE_ID, { repositoryId: "same" })).toBeNull();
    expect(repositoryRouteFromParams(SCOPED_REPOSITORY_ROUTE_ID, { environmentId: "host" })).toBeNull();
    expect(repositoryRouteFromParams("/settings", { repositoryId: "same" })).toBeNull();
  });

  it("recognizes every settings route", () => {
    expect(isSettingsRouteId("/settings")).toBe(true);
    expect(isSettingsRouteId("/settings/general")).toBe(true);
    expect(isSettingsRouteId("/settings/appearance")).toBe(true);
    expect(isSettingsRouteId("/settings/connections")).toBe(true);
  });

  it("does not treat other routes as settings routes", () => {
    expect(isSettingsRouteId("/")).toBe(false);
    expect(isSettingsRouteId("/new")).toBe(false);
    expect(isSettingsRouteId("/repo/repo-1")).toBe(false);
    expect(isSettingsRouteId("/settings-other")).toBe(false);
    expect(isSettingsRouteId(null)).toBe(false);
  });

  it("reads a repository identifier from a route parameter", () => {
    expect(repositoryIdFromParam("repo-4f1a5a9c10c8f782")).toBe("repo-4f1a5a9c10c8f782");
    expect(repositoryIdFromParam(undefined)).toBeNull();
    expect(repositoryIdFromParam("")).toBeNull();
    expect(repositoryIdFromParam("   ")).toBeNull();
  });
});
