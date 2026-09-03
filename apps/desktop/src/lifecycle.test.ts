import { describe, expect, it } from "vitest";
import { extractDeepLink, normalizeDeepLink, normalizeUpdateFeedUrl } from "./lifecycle.js";

describe("desktop lifecycle inputs", () => {
  it("extracts external GitGui deep links without accepting the app origin", () => {
    expect(extractDeepLink(["GitGui.exe", "--flag", "gitgui://connect/environment"])).toBe("gitgui://connect/environment");
    expect(normalizeDeepLink("gitgui://app/index.html")).toBeNull();
    expect(normalizeDeepLink("gitgui://connect/environment?token=secret")).toBeNull();
    expect(normalizeDeepLink("gitgui://connect/environment#secret")).toBeNull();
    expect(normalizeDeepLink("https://example.test")).toBeNull();
  });

  it("accepts only credential-free HTTPS update feeds", () => {
    expect(normalizeUpdateFeedUrl("https://updates.example.test/gitgui/")).toBe("https://updates.example.test/gitgui");
    expect(normalizeUpdateFeedUrl("http://updates.example.test")).toBeNull();
    expect(normalizeUpdateFeedUrl("https://user:secret@updates.example.test")).toBeNull();
  });
});
