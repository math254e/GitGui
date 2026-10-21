import { describe, expect, it } from "vitest";
import { resolveDeepLinkTarget } from "./deep-links";

describe("deep link targets", () => {
  it("opens a repository", () => {
    expect(resolveDeepLinkTarget("gitgui://repo/repo-4f1a5a9c10c8f782")).toBe(
      "/repo/repo-4f1a5a9c10c8f782",
    );
  });

  it("opens the settings", () => {
    expect(resolveDeepLinkTarget("gitgui://settings")).toBe("/settings/general");
    expect(resolveDeepLinkTarget("gitgui://settings/")).toBe("/settings/general");
  });

  it("ignores links it does not understand", () => {
    expect(resolveDeepLinkTarget("gitgui://app/repo/repo-1")).toBeNull();
    expect(resolveDeepLinkTarget("gitgui://repo")).toBeNull();
    expect(resolveDeepLinkTarget("gitgui://repo/repo-1/extra")).toBeNull();
    expect(resolveDeepLinkTarget("https://example.com/repo/repo-1")).toBeNull();
    expect(resolveDeepLinkTarget("not a url")).toBeNull();
  });
});
