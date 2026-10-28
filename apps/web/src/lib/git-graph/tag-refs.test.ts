import { describe, expect, it } from "vitest";
import type { CommitInfo, CommitRef } from "$lib/types/repository";
import { buildRefBadges } from "./ref-badges";
import { graphTargets } from "./targets";

describe("large tag collections in the graph", () => {
  it("bounds tag badges while retaining branch badges and every tag in source data", () => {
    const branch: CommitRef = { refType: "localBranch", name: "refs/heads/main", shortName: "main", target: "head" };
    const refs = [branch, ...Array.from({ length: 10_000 }, (_, i): CommitRef => ({ ...branch, refType: "tag", name: `refs/tags/v${i}`, shortName: `v${i}` }))];
    const badges = buildRefBadges(new Map([["head", refs]])).get("head")!;
    expect(badges.refs).toHaveLength(4);
    expect(badges.refs[0]).toBe(branch);
    expect(badges.additionalTags).toBe(9997);
    expect(refs).toHaveLength(10_001);
  });

  it("reduces thousands of ancestral tag targets to their descendant tips without dropping independent histories", () => {
    const commits: CommitInfo[] = Array.from({ length: 10_000 }, (_, i) => ({ hash: String(i), parents: i ? [String(i - 1)] : [], author: "Me", message: "", timestamp: i }));
    commits.push({ hash: "other", parents: [], author: "Me", message: "", timestamp: 1 });
    expect(graphTargets(commits, [...commits.map((c) => c.hash), "blob", "9999"])).toEqual(["9999", "other"]);
  });
});
