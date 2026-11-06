import { describe, expect, it } from "vitest";
import { defaultEnvironmentName, environmentName, parseEnvironmentNames } from "./names.ts";

describe("environment names", () => {
  it("normalizes historical defaults without changing custom names", () => {
    expect(defaultEnvironmentName("GitGui on MATHIES-DESKTOP")).toBe("MATHIES-DESKTOP");
    expect(defaultEnvironmentName("GitGui on This computer", "build-host")).toBe("build-host");
    expect(defaultEnvironmentName("This computer", "remote.example.com")).toBe("remote.example.com");
    expect(defaultEnvironmentName("Work server", "build-host")).toBe("Work server");
    expect(defaultEnvironmentName("GitGui development", "build-host")).toBe("GitGui development");
    expect(defaultEnvironmentName("GitGui on my build machine", "build-host")).toBe("GitGui on my build machine");
    expect(defaultEnvironmentName(" ")).toBe("This computer");
  });

  it("keeps explicit names verbatim after trimming, including the historical prefix", () => {
    expect(environmentName("  GitGui on purpose  ")).toBe("GitGui on purpose");
    expect(parseEnvironmentNames({ host: "GitGui on purpose", other: "机房", invalid: "\n", secret: { token: "fixture" } }))
      .toEqual({ host: "GitGui on purpose", other: "机房" });
    expect(parseEnvironmentNames(JSON.parse('{"__proto__":"Host"}'))).toHaveProperty("__proto__", "Host");
  });

  it.each(["", "   ", "a\nb", "a\0b", "a".repeat(513)])("rejects unusable names", (name) => {
    expect(() => environmentName(name)).toThrow("environment name");
  });
});
