import { describe, expect, it } from "vitest";
import { resolveDeepLinkTarget } from "./deep-links";

describe("deep link targets", () => {
  it("opens a repository", () => {
    expect(resolveDeepLinkTarget("gitgui://repo/repo-4f1a5a9c10c8f782")).toBe(
      "/repo/repo-4f1a5a9c10c8f782",
    );
  });

  it("opens an explicitly scoped repository without choosing a host for old links", () => {
    expect(resolveDeepLinkTarget("gitgui://repo/remote/repo-1")).toBe("/repo/remote/repo-1");
    expect(resolveDeepLinkTarget("gitgui://repo/repo-1")).toBe("/repo/repo-1");
    expect(resolveDeepLinkTarget("gitgui://repo/host%2Fone/repo%25two")).toBe("/repo/host%2Fone/repo%25two");
  });

  it("opens the settings", () => {
    expect(resolveDeepLinkTarget("gitgui://settings")).toBe("/settings/general");
    expect(resolveDeepLinkTarget("gitgui://settings/")).toBe("/settings/general");
  });

  it("ignores links it does not understand", () => {
    expect(resolveDeepLinkTarget("gitgui://app/repo/repo-1")).toBeNull();
    expect(resolveDeepLinkTarget("gitgui://repo")).toBeNull();
    expect(resolveDeepLinkTarget("gitgui://repo/host/repo-1/extra")).toBeNull();
    expect(resolveDeepLinkTarget("https://example.com/repo/repo-1")).toBeNull();
    expect(resolveDeepLinkTarget("not a url")).toBeNull();
    expect(resolveDeepLinkTarget("gitgui://repo/%ZZ")).toBeNull();
    expect(resolveDeepLinkTarget("gitgui://repo/host/%ZZ")).toBeNull();
    expect(resolveDeepLinkTarget("gitgui://repo/host//repo")).toBeNull();
    expect(resolveDeepLinkTarget("gitgui://repo/%20/repo")).toBeNull();
    expect(resolveDeepLinkTarget("gitgui://user:secret@repo/host/repo")).toBeNull();
    expect(resolveDeepLinkTarget("gitgui://repo/host/repo?token=secret")).toBeNull();
    expect(resolveDeepLinkTarget("gitgui://repo/host/repo#fragment")).toBeNull();
  });
});
