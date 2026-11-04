// Adapted from T3 Code 70cd258d8aac43ea57494527b00bf36de3efa6c0 SSH config/auth/command tests; see docs/ssh-primitives.md.
import { describe, it, expect } from "vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { discoverSshHosts, parseKnownHostsHostnames } from "./config.js";
import { baseSshArgs, buildSshHostSpec, parseSshResolveOutput, remoteStateKey } from "./command.js";
import { ASKPASS_POSIX_SCRIPT, ASKPASS_WINDOWS_SCRIPT, buildSshAskpassHelperDescriptor } from "./auth.js";
import { HostProcessPlatform } from "./platform.js";

describe("SSH primitives", () => {
  it("discovers multiple aliases through includes and ignores patterns and hashed hosts", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "gitgui-ssh-test-"));
    try {
      await fs.mkdir(path.join(home, ".ssh", "config.d"), { recursive: true });
      await fs.writeFile(path.join(home, ".ssh", "config"), "Host first second * !bad\nInclude config.d/*.conf\n");
      await fs.writeFile(path.join(home, ".ssh", "config.d", "a.conf"), "Host third\nInclude config\n");
      await fs.writeFile(path.join(home, ".ssh", "known_hosts"), "|1|hash|key ssh-ed25519 AAA\n[known]:2222 ssh-ed25519 AAA\n");
      const hosts = await Effect.runPromise(discoverSshHosts({ homeDir: home }).pipe(Effect.provide(NodeServices.layer)));
      expect(hosts.map(h => h.alias)).toEqual(["first", "known", "second", "third"]);
      expect(parseKnownHostsHostnames("|1|hash|key ssh-ed25519 AAA")).toEqual([]);
    } finally { await fs.rm(home, { recursive: true, force: true }); }
  });
  it("preserves the alias and identity override, and hashes the full key", () => {
    const target = { ...parseSshResolveOutput("jump-alias", "hostname actual.example\nuser alice\nport 2222\n"), identityFile: "C:/my keys/id" };
    expect(buildSshHostSpec(target)).toBe("alice@jump-alias");
    expect(baseSshArgs(target)).toContain("C:/my keys/id");
    expect(remoteStateKey(target)).toHaveLength(64);
    expect(remoteStateKey(target)).not.toBe(remoteStateKey({ ...target, identityFile: "another" }));
    expect(() => buildSshHostSpec({ ...target, alias: "-oProxyCommand=bad" })).toThrow();
  });
  it("uses the upstream Windows helper and refuses trust questions", async () => {
    const descriptor = await Effect.runPromise(buildSshAskpassHelperDescriptor({ directory: "C:\\test" }).pipe(Effect.provide(NodeServices.layer), Effect.provideService(HostProcessPlatform, "win32")));
    expect(descriptor.launcherPath).toMatch(/\.cmd$/);
    expect(ASKPASS_WINDOWS_SCRIPT).toContain("yes/no|fingerprint");
    expect(ASKPASS_POSIX_SCRIPT).toContain('*"yes/no"*');
  });
});
