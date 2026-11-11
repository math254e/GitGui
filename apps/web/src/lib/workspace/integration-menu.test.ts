import { describe, expect, it } from "vitest";
import { integrationRecoveryMenuItems } from "./integration-menu";

describe("integration recovery context menu", () => {
  it("blocks continue with unresolved conflicts and offers rebase skip and abort", () => {
    const items = integrationRecoveryMenuItems({ kind: "rebase", unresolvedPaths: ["conflict.txt"] }, true);
    expect(items.map((item) => item.id)).toEqual(["continue", "skip", "abort"]);
    expect(items[0].disabled).toBe(true);
    expect(items[1].disabled).toBe(false);
    expect(items[2].destructive).toBe(true);
  });

  it("enables continue after staging and never offers skip for merge", () => {
    const items = integrationRecoveryMenuItems({ kind: "merge", unresolvedPaths: [] }, true);
    expect(items.map((item) => item.id)).toEqual(["continue", "abort"]);
    expect(items[0].disabled).toBe(false);
    expect(integrationRecoveryMenuItems({ kind: "merge", unresolvedPaths: [] }, false).every((item) => item.disabled)).toBe(true);
    expect(integrationRecoveryMenuItems({ kind: "unknown", unresolvedPaths: [] }, true)).toEqual([]);
  });
});
