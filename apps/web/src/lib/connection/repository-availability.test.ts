import { describe, expect, it } from "vitest";
import { repositoryManagementAvailability as availability } from "./repository-availability";

describe("repository management availability", () => {
  const capabilities = ["repositories.open", "repositories.create", "repositories.remove"];
  it.each(["open", "create", "remove"] as const)("requires a known live grant for %s", (action) => {
    expect(availability(action, true, ["repository:read", "repository:operate"], capabilities)).toMatchObject({ allowed: false, reason: expect.stringContaining("repository:manage") });
    expect(availability(action, true, [], capabilities).allowed).toBe(false);
    expect(availability(action, true, null, capabilities)).toMatchObject({ allowed: false, reason: expect.stringContaining("authorization is unavailable") });
    expect(availability(action, true, undefined, capabilities).allowed).toBe(false);
    expect(availability(action, false, ["repository:manage"], capabilities).allowed).toBe(false);
    expect(availability(action, true, ["repository:manage"], capabilities).allowed).toBe(true);
  });
  it("checks each implementation capability independently of the grant", () => {
    expect(availability("open", true, ["repository:manage"], ["repositories.create"]).allowed).toBe(false);
    expect(availability("create", true, ["repository:manage"], ["repositories.create"]).allowed).toBe(true);
    expect(availability("remove", true, ["repository:manage"], null).allowed).toBe(false);
  });
});
