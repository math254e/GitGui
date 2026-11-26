import { describe, expect, it } from "vitest";
import { desktopRepositoryPath } from "./repository-path.js";

describe("desktop repository paths", () => {
  it("converts canonical Windows drive and network paths for desktop apps", () => {
    expect(desktopRepositoryPath(String.raw`\\?\D:\My Projects\repo`, "win32")).toBe(String.raw`D:\My Projects\repo`);
    expect(desktopRepositoryPath(String.raw`\\?\UNC\server\share\repo`, "win32")).toBe(String.raw`\\server\share\repo`);
  });

  it("preserves ordinary and non-Windows paths", () => {
    expect(desktopRepositoryPath(String.raw`D:\repo`, "win32")).toBe(String.raw`D:\repo`);
    expect(desktopRepositoryPath("/home/me/repo", "linux")).toBe("/home/me/repo");
  });
});
