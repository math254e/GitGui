import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeHostResponse, locatorFor, cleanupOutcome } from "./runner.js";
import { environmentId, hostResponse } from "../testing/manager-fixture.js";
import { commandFailure } from "./command.js";
import { isValidEnvironmentId } from "@gitgui/contracts/environment";

describe("SSH structured helper boundary", () => {
  const id = randomUUID();
  const request = { version: 1, acquisitionId: id, locator: { kind: "default" as const }, expectedEnvironmentId: null, instanceId: null };
  it("retains opaque legacy environment IDs while acquisition/instance IDs remain UUIDs", () => {
    const legacyId = "gitgui-123456-1788413802919117400";
    const response = { ...hostResponse(request), environmentId: legacyId };
    expect(decodeHostResponse(JSON.stringify(response), id, "ensure").environmentId).toBe(legacyId);
    expect(locatorFor({ kind: "ssh", host: "host", remoteDataDirectory: "/existing/state" }, legacyId)).toEqual({ kind: "directory", path: "/existing/state", environmentId: legacyId });
    expect(() => decodeHostResponse(JSON.stringify({ ...response, instanceId: legacyId }), id, "ensure")).toThrow();
    for (const invalid of ["", " ", " padded", "line\nbreak", "x".repeat(257), "é".repeat(129)]) {
      expect(isValidEnvironmentId(invalid)).toBe(false);
      expect(() => decodeHostResponse(JSON.stringify({ ...response, environmentId: invalid }), id, "ensure")).toThrow();
    }
  });
  it("decodes only a bounded, single response for the exact reserved acquisition", () => {
    const response = hostResponse(request);
    expect(decodeHostResponse(`${JSON.stringify(response)}\n`, id, "ensure")).toEqual(response);
    for (const output of ["noise\n" + JSON.stringify(response), JSON.stringify({ ...response, acquisitionId: randomUUID() }), JSON.stringify({ ...response, port: 0 }), JSON.stringify({ ...response, url: "http://evil" }), "x".repeat(16385), JSON.stringify({ ...response, version: 2 })]) {
      expect(() => decodeHostResponse(output, id, "ensure")).toThrow();
    }
  });
  it("does not accept a credential as launch metadata or an unbound remote URL", () => {
    const response = { ...hostResponse(request), pairing: { credential: "secret", expiresIn: 600, scopes: [] } };
    expect(() => decodeHostResponse(JSON.stringify(response), id, "ensure")).toThrow();
    expect(decodeHostResponse(JSON.stringify(response), id, "pairing").pairing!.credential).toBe("secret");
  });
  it("selects the per-user default for new connections and preserves the exact legacy key for saved connections", () => {
    const profile = { kind: "ssh" as const, host: "long-host-".repeat(12), user: "alice", port: 2222, identityFile: "key with spaces" };
    expect(locatorFor(profile)).toEqual({ kind: "default" });
    expect(locatorFor(profile, environmentId)).toEqual({ kind: "legacy", stateKey: Buffer.from(`${profile.user}@${profile.host}:${profile.port}:${profile.identityFile}`).toString("base64url").slice(0, 48), environmentId });
    expect(locatorFor({ ...profile, remoteDataDirectory: "/existing/state" }, environmentId)).toEqual({ kind: "directory", path: "/existing/state", environmentId });
    expect(() => locatorFor({ ...profile, remoteDataDirectory: "/existing/state" })).toThrow();
  });
  it("preserves retained and cleanup-pending outcomes without claiming exit", () => {
    expect(cleanupOutcome(hostResponse(request, "cleanup-pending"))).toBe("cleanup-pending");
    expect(cleanupOutcome(hostResponse(request, "retained"))).toBe("retained");
    expect(cleanupOutcome(hostResponse(request, "failed"))).toBe("cleanup-pending");
  });
  it.each([
    ["Permission denied (publickey,password)", "authentication"], ["Connection timed out", "transport"],
    ["Host key verification failed", "permission"], ["REMOTE HOST IDENTIFICATION HAS CHANGED", "permission"],
    ["gitgui-server: not found", "unsupported"], ["Bad configuration option", "configuration"],
  ])("classifies OpenSSH privately and sends only typed static diagnostics: %s", (stderr, category) => {
    const error = commandFailure(`${stderr}\nprivate-credential`, 255);
    expect(error.category).toBe(category);
    expect(JSON.stringify(error)).not.toContain("private-credential");
    expect(error.stderr).toBe("");
  });
});
