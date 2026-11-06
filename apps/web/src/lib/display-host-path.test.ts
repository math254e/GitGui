import { describe, expect, it } from "vitest";
import { displayHostPath } from "./display-host-path";

describe("displayHostPath", () => {
  it("shows Windows drive and UNC paths without the extended-length prefix", () => {
    expect(displayHostPath("\\\\?\\D:\\ProgrammingProjects\\GitGui")).toBe("D:\\ProgrammingProjects\\GitGui");
    expect(displayHostPath("\\\\?\\UNC\\server\\share\\repo")).toBe("\\\\server\\share\\repo");
  });
  it("leaves normal, remote, and unknown device paths alone", () => {
    for (const path of ["D:\\repo", "/home/me/repo", "\\\\server\\share\\repo", "\\\\?\\Volume{123}\\repo"]) {
      expect(displayHostPath(path)).toBe(path);
    }
  });
});
