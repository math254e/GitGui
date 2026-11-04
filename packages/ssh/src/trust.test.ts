import { generateKeyPairSync, createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import { confirmUnknownHost, parseScannedKeys, type SshHostTrustRequest } from "./trust.js";
import { runLocalCommand } from "./command.js";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const field = (input: Buffer) => { const size = Buffer.alloc(4); size.writeUInt32BE(input.length); return Buffer.concat([size, input]); };
const { publicKey } = generateKeyPairSync("ed25519");
const bytes = Buffer.concat([field(Buffer.from("ssh-ed25519")), field(publicKey.export({ type: "spki", format: "der" }).subarray(-32))]);
const key = bytes.toString("base64");
const scanned = `actual.example ssh-ed25519 ${key}\n`;
const expectedFingerprint = `SHA256:${createHash("sha256").update(bytes).digest("base64").replace(/=+$/, "")}`;
async function home() { const directory = await mkdtemp(join(tmpdir(), "gitgui-ssh-trust-")); directories.push(directory); return directory; }
function fakeScan() {
  return ChildProcessSpawner.makeHandle({ pid: ChildProcessSpawner.ProcessId(1), stdout: Stream.make(Buffer.from(scanned)), stderr: Stream.empty, all: Stream.empty,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)), isRunning: Effect.succeed(false), kill: () => Effect.void, stdin: Sink.drain, getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty, unref: Effect.succeed(Effect.void) });
}

describe("SSH host trust (real ssh-keygen database lookup, fixture network scan)", () => {
  it("shows the actual SHA256 fingerprint and pins only the approved key in system-format known_hosts", async () => {
    const directory = await home(); const file = join(directory, "known_hosts");
    const requests: SshHostTrustRequest[] = [];
    await Effect.runPromise(Effect.gen(function* () {
      const native = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawner = ChildProcessSpawner.make(command => command._tag === "StandardCommand" && command.command === "ssh-keyscan" ? Effect.succeed(fakeScan()) : native.spawn(command));
      yield* confirmUnknownHost({ alias: "saved-alias", hostname: "actual.example", username: "alice", port: 2222, userKnownHostsFiles: [file], globalKnownHostsFiles: [] }, input => Effect.sync(() => { requests.push(input); return true; })).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      const lookup = yield* runLocalCommand("ssh-keygen", ["-F", "[actual.example]:2222", "-f", file]);
      expect(lookup.exitCode).toBe(0);
      expect(lookup.stdout).toContain(key);
      const fingerprint = yield* runLocalCommand("ssh-keygen", ["-lf", file, "-E", "sha256"]);
      expect(fingerprint.exitCode).toBe(0);
      expect(fingerprint.stdout).toContain(expectedFingerprint);
    }).pipe(Effect.provide(NodeServices.layer)));
    expect(requests).toEqual([{ alias: "saved-alias", hostname: "actual.example", port: 2222, fingerprints: [`ssh-ed25519 ${expectedFingerprint}`] }]);
    expect(await readFile(file, "utf8")).toBe(`\n[actual.example]:2222 ssh-ed25519 ${key}\n`);
  });
  it("blocks existing (including hashed) known keys before presenting a trust prompt", async () => {
    const directory = await home(); const file = join(directory, "known_hosts");
    await writeFile(file, `[actual.example]:2222 ssh-ed25519 ${key}\n`);
    let asked = false;
    await Effect.runPromise(runLocalCommand("ssh-keygen", ["-H", "-f", file]).pipe(Effect.provide(NodeServices.layer)));
    await expect(Effect.runPromise(confirmUnknownHost({ alias: "alias", hostname: "actual.example", username: null, port: 2222, userKnownHostsFiles: [file], globalKnownHostsFiles: [] }, () => Effect.sync(() => { asked = true; return true; })).pipe(Effect.provide(NodeServices.layer)))).rejects.toMatchObject({ category: "permission" });
    expect(asked).toBe(false);
    expect(await readFile(file, "utf8")).toMatch(/^\|1\|/);
  });
  it("does not pin a declined key, and blocks a proxy route requiring system OpenSSH trust", async () => {
    const directory = await home(); const file = join(directory, "known_hosts");
    const target = { alias: "alias", hostname: "actual.example", username: null, port: 22, userKnownHostsFiles: [file], globalKnownHostsFiles: [] };
    const effect = Effect.gen(function* () {
      const spawner = ChildProcessSpawner.make(() => Effect.succeed(fakeScan()));
      return yield* confirmUnknownHost(target, () => Effect.succeed(false)).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
    });
    await expect(Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))).rejects.toMatchObject({ category: "permission" });
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(Effect.runPromise(confirmUnknownHost({ ...target, proxy: true }, () => Effect.die("must not present")).pipe(Effect.provide(NodeServices.layer)))).rejects.toMatchObject({ category: "permission" });
  });
  it("rejects mismatched wire key algorithms and malformed scan output", () => {
    expect(parseScannedKeys(scanned)[0].fingerprint).toBe(`ssh-ed25519 ${expectedFingerprint}`);
    expect(() => parseScannedKeys(`host ssh-rsa ${key}\n`)).toThrow();
    expect(() => parseScannedKeys("host ssh-ed25519 AA\n")).toThrow();
    expect(() => parseScannedKeys("# no key\n")).toThrow();
  });
});
