import { describe, expect, it } from "vitest";
import {
  isSettingsRouteId,
  repositoryIdFromParam,
  repositoryPath,
  settingsPath,
} from "./routes";

describe("route paths", () => {
  it("builds a repository path from a server-issued identifier", () => {
    expect(repositoryPath("repo-4f1a5a9c10c8f782")).toBe("/repo/repo-4f1a5a9c10c8f782");
  });

  it("escapes identifiers that would otherwise change the path", () => {
    expect(repositoryPath("repo/../settings")).toBe("/repo/repo%2F..%2Fsettings");
  });

  it("builds settings paths from a section name", () => {
    expect(settingsPath("general")).toBe("/settings/general");
    expect(settingsPath("appearance")).toBe("/settings/appearance");
    expect(settingsPath("connections")).toBe("/settings/connections");
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
