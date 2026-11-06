import { describe, expect, it } from "vitest";
import { buildRepositoryGroups, groupRepositoryCatalogs, scopedRepositoryKey } from "./repository.ts";
import { CheckoutAlreadyOpenError, closeRepositoryTab, openRepositoryTab, removeEnvironmentTabs, selectRepositoryTab, switchRepositoryTab } from "./tabs.ts";

const ref = (environmentId: string, repositoryId: string) => ({ environmentId, repositoryId });

describe("repository grouping", () => {
  it("groups generated catalog identities without losing their environment targets", () => {
    const summary = { id: "repo", name: "Repo", path: "/repo", root: "/repo", isWorktree: false,
      repositoryIdentity: { canonicalKey: "host/team/repo" } };
    const groups = groupRepositoryCatalogs({ local: [summary], remote: [summary] });
    expect(groups).toHaveLength(1);
    expect(groups[0].members.map((member) => member.ref.environmentId)).toEqual(["local", "remote"]);
  });
  it("keeps every clone across environments, including equal host-local IDs", () => {
    const repositories = [
      { ref: ref("local", "one"), identityKey: "github.com/team/project" },
      { ref: ref("local", "two"), identityKey: "github.com/team/project" },
      { ref: ref("remote", "one"), identityKey: "github.com/team/project" },
    ];
    expect(buildRepositoryGroups(repositories)[0].members).toEqual(repositories);
    expect(scopedRepositoryKey(repositories[0].ref)).not.toBe(scopedRepositoryKey(repositories[2].ref));
    expect(scopedRepositoryKey(ref("a:b", "c"))).not.toBe(scopedRepositoryKey(ref("a", "b:c")));
  });

  it("groups no-remote worktrees only within their host family and preserves independent clones", () => {
    const groups = buildRepositoryGroups([
      { ref: ref("one", "main"), worktreeFamilyKey: "family" },
      { ref: ref("one", "worktree"), worktreeFamilyKey: "family" },
      { ref: ref("two", "main"), worktreeFamilyKey: "family" },
      { ref: ref("one", "clone") },
    ]);
    expect(groups.map((group) => group.members.length)).toEqual([2, 1, 1]);
  });

  it("uses an unambiguous family identity for a worktree with missing metadata", () => {
    const groups = buildRepositoryGroups([
      { ref: ref("one", "main"), worktreeFamilyKey: "family", identityKey: "host/project" },
      { ref: ref("one", "worktree"), worktreeFamilyKey: "family" },
      { ref: ref("two", "clone"), identityKey: "host/project" },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toHaveLength(3);
  });

  it("does not guess a family identity when its worktrees disagree", () => {
    const groups = buildRepositoryGroups([
      { ref: ref("one", "main"), worktreeFamilyKey: "family", identityKey: "host/one" },
      { ref: ref("one", "worktree"), worktreeFamilyKey: "family", identityKey: "host/two" },
      { ref: ref("one", "unknown"), worktreeFamilyKey: "family" },
    ]);
    expect(groups).toHaveLength(3);
  });

  it("does not retain credential-bearing identity hints in group keys", () => {
    const groups = buildRepositoryGroups([
      { ref: ref("one", "repo"), identityKey: "https://user:secret@host/team/repo" },
      { ref: ref("two", "repo"), identityKey: "https://user:secret@host/team/repo" },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.key).join(" ")).not.toContain("secret");
  });
});

describe("repository tab transitions", () => {
  it("allows different environments and worktrees, but rejects duplicate opens and switches", () => {
    const local = ref("local", "repo");
    const remote = ref("remote", "repo");
    const worktree = ref("local", "worktree");
    const first = openRepositoryTab({ tabs: [], activeTabId: null }, { tabId: "one", target: local });
    const second = openRepositoryTab(first, { tabId: "two", target: remote });
    const third = openRepositoryTab(second, { tabId: "three", target: worktree });
    expect(() => openRepositoryTab(third, { tabId: "four", target: local })).toThrow(CheckoutAlreadyOpenError);
    expect(() => switchRepositoryTab(third, "two", worktree)).toThrow(CheckoutAlreadyOpenError);
    expect(switchRepositoryTab(third, "two", remote)).toBe(third);
    const switched = switchRepositoryTab(third, "two", ref("remote", "other"));
    expect(switched.tabs.map((tab) => tab.tabId)).toEqual(["one", "two", "three"]);
    expect(closeRepositoryTab(switched, "three").activeTabId).toBe("two");
  });

  it("removes only the selected environment's tabs", () => {
    const a = openRepositoryTab({ tabs: [], activeTabId: null }, { tabId: "a", target: ref("local", "repo") });
    const b = openRepositoryTab(a, { tabId: "b", target: ref("remote", "repo") });
    const c = openRepositoryTab(b, { tabId: "c", target: ref("local", "other") });
    const selected = selectRepositoryTab(c, "b");
    const removed = removeEnvironmentTabs(selected, "remote");
    expect(removed.tabs.map((tab) => tab.tabId)).toEqual(["a", "c"]);
    expect(removed.activeTabId).toBe("c");
    expect(removeEnvironmentTabs(removed, "missing")).toBe(removed);
  });
});
