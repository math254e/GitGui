import { describe, expect, it } from "vitest";
import {
  resolveClosedRepositoryTarget,
  resolveRouteIntent,
} from "./repository-routing";

describe("route intent", () => {
  it("does nothing when the route points at no repository", () => {
    expect(
      resolveRouteIntent({
        routedRepositoryId: null,
        openRepositoryIds: ["repo-a"],
        activeRepositoryId: "repo-a",
      }),
    ).toEqual({ kind: "none" });
  });

  it("opens a repository the workspace does not have open", () => {
    expect(
      resolveRouteIntent({
        routedRepositoryId: "repo-b",
        openRepositoryIds: ["repo-a"],
        activeRepositoryId: "repo-a",
      }),
    ).toEqual({ kind: "open", repositoryId: "repo-b" });
  });

  it("selects an open repository that is not the active one", () => {
    expect(
      resolveRouteIntent({
        routedRepositoryId: "repo-b",
        openRepositoryIds: ["repo-a", "repo-b"],
        activeRepositoryId: "repo-a",
      }),
    ).toEqual({ kind: "select", repositoryId: "repo-b" });
  });

  it("does nothing when the routed repository is already active", () => {
    expect(
      resolveRouteIntent({
        routedRepositoryId: "repo-a",
        openRepositoryIds: ["repo-a", "repo-b"],
        activeRepositoryId: "repo-a",
      }),
    ).toEqual({ kind: "none" });
  });
});

describe("closed repository target", () => {
  it("moves to the next open repository", () => {
    expect(resolveClosedRepositoryTarget("repo-b")).toBe("/repo/repo-b");
  });

  it("moves to the repositories home page when the last tab closes", () => {
    expect(resolveClosedRepositoryTarget(null)).toBe("/");
  });
});
