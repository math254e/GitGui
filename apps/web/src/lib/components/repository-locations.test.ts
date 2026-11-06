import { describe, expect, it } from "vitest";
import { groupRepositoryCatalogs } from "@gitgui/client-runtime/workspace";
import type { EnvironmentEntryView } from "$lib/connection/runtime";
import { repositoryLocations } from "./repository-locations";

const summary = (id: string, path: string, family?: string) => ({ id, name: "repo", path, root: path, isWorktree: false,
  repositoryIdentity: { canonicalKey: "host/team/repo" }, ...(family ? { worktreeFamily: { id: family, mainRoot: "/main" } } : {}) });
const entry = (id: string, kind = "bearer", phase = "connected") => ({ registration: { environmentId: id, displayName: id, target: { kind } }, connection: { phase } }) as EnvironmentEntryView;

describe("repository location projection", () => {
  it("hides local-only while preserving multiple locations on the same remote environment", () => {
    const local = [summary("one", "/one"), summary("two", "/two")];
    const group = groupRepositoryCatalogs({ local })[0];
    const current = { environmentId: "local", repositoryId: "one" };
    expect(repositoryLocations(group, [entry("local", "primary")], current, true)).toEqual([]);
    const environments = repositoryLocations(groupRepositoryCatalogs({ local, remote: [summary("one", "/remote"), summary("two", "/other")] })[0],
      [entry("local", "primary"), entry("remote")], current, true);
    expect(environments.map((environment) => environment.locations.length)).toEqual([2, 2]);
    expect(environments[1].locations.map((location) => location.target.repositoryId)).toEqual(["one", "two"]);
  });

  it("shows a remote-only environment and collapses linked worktrees into their clone family", () => {
    const current = { environmentId: "remote", repositoryId: "worktree" };
    const group = groupRepositoryCatalogs({ remote: [summary("main", "/main", "family"), summary("worktree", "/linked", "family"), summary("clone", "/clone")] })[0];
    const environments = repositoryLocations(group, [entry("remote", "ssh", "offline")], current, true);
    expect(environments).toHaveLength(1);
    expect(environments[0].status).toBe("offline");
    expect(environments[0].locations).toEqual([
      { target: current, path: "/linked", missing: false, current: true },
      { target: { environmentId: "remote", repositoryId: "clone" }, path: "/clone", missing: false, current: false },
    ]);
  });

  it("does not call a browser's primary server local merely because it is primary", () => {
    const current = { environmentId: "primary", repositoryId: "one" };
    const group = groupRepositoryCatalogs({ primary: [summary("one", "/one")] })[0];
    expect(repositoryLocations(group, [entry("primary", "primary")], current, false)).toHaveLength(1);
  });
});
