// GitGui addition at T3 Code 70cd258d8aac43ea57494527b00bf36de3efa6c0's
// packages/ssh/src/{auth,command}.ts boundary, not a copied upstream trust flow.
// Trust is deliberately separate
// from cached askpass secrets. See docs/ssh-manager.md for proxy limitations.
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { runLocalCommand, type ResolvedSshTarget } from "./command.js";
import { SshFailure } from "./errors.js";

export interface SshHostTrustRequest {
  readonly alias: string;
  readonly hostname: string;
  readonly port: number;
  readonly fingerprints: readonly string[];
}
const trustFailure = () => new SshFailure({ category: "permission", message: "SSH host identity could not be verified. Verify this host with system OpenSSH before connecting." });
export function parseScannedKeys(output: string): readonly { algorithm: string; key: string; fingerprint: string }[] {
  const keys = new Map<string, { algorithm: string; key: string; fingerprint: string }>();
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 3 || !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521))$/.test(fields[1]) || !/^[A-Za-z0-9+/]+={0,2}$/.test(fields[2])) throw trustFailure();
    const bytes = Buffer.from(fields[2], "base64");
    if (bytes.length < 16 || bytes.length > 16384) throw trustFailure();
    // Bind the wire key type as well as the text type; arbitrary scan output is untrusted.
    const length = bytes.readUInt32BE(0);
    if (length > bytes.length - 4 || bytes.subarray(4, 4 + length).toString() !== fields[1]) throw trustFailure();
    keys.set(`${fields[1]} ${fields[2]}`, { algorithm: fields[1], key: fields[2], fingerprint: `${fields[1]} SHA256:${createHash("sha256").update(bytes).digest("base64").replace(/=+$/, "")}` });
  }
  if (keys.size === 0 || keys.size > 8) throw trustFailure();
  return [...keys.values()];
}

export const confirmUnknownHost = Effect.fn("ssh.trust.confirm")(function* (
  target: ResolvedSshTarget,
  confirm: (request: SshHostTrustRequest) => Effect.Effect<boolean, SshFailure>,
) {
  if (target.proxy || target.hostname.startsWith("-") || /[\s\x00-\x1f]/.test(target.hostname)) return yield* trustFailure();
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const expand = (s: string) => s.replace(/^~(?=[/\\]|$)/, homedir());
  const userFiles = target.userKnownHostsFiles ?? [path.join(homedir(), ".ssh", "known_hosts")];
  const files = [...userFiles, ...(target.globalKnownHostsFiles ?? [])].map(expand).filter(f => f !== "none");
  const port = target.port ?? 22;
  const host = target.hostKeyAlias ?? target.hostname;
  const lookup = port === 22 ? host : `[${host}]:${port}`;
  if (/[\s\x00-\x1f]/.test(lookup)) return yield* trustFailure();
  const verifyAbsent = Effect.gen(function* () {
    for (const file of files) {
      if (!(yield* fs.exists(file))) continue;
      const result = yield* runLocalCommand("ssh-keygen", ["-F", lookup, "-f", file], { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 });
      // Includes hashed names, revoked keys and certificate authorities. Never
      // overwrite an existing key or turn a changed key into an unknown host.
      if (result.exitCode !== 1 || result.stdout.trim()) return yield* trustFailure();
    }
  });
  yield* verifyAbsent;
  const scanned = yield* runLocalCommand("ssh-keyscan", ["-T", "10", "-p", String(port), target.hostname], { timeoutMs: 15_000, maxOutputBytes: 64 * 1024 });
  if (scanned.exitCode !== 0) return yield* trustFailure();
  const keys = yield* Effect.try({ try: () => parseScannedKeys(scanned.stdout), catch: trustFailure });
  const approved = yield* confirm({ alias: target.alias, hostname: target.hostname, port, fingerprints: keys.map(k => k.fingerprint) });
  if (!approved) return yield* new SshFailure({ category: "permission", message: "SSH host trust was declined." });
  // Recheck after the dialog; another application may have modified known_hosts.
  yield* verifyAbsent;
  const destination = userFiles.find(f => f !== "none");
  if (!destination) return yield* trustFailure();
  const file = expand(destination);
  yield* fs.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 });
  yield* fs.writeFileString(file, `\n${keys.map(k => `${lookup} ${k.algorithm} ${k.key}`).join("\n")}\n`, { flag: "a", mode: 0o600 });
  // The retry still uses StrictHostKeyChecking=yes and system known_hosts. Only
  // the key bytes shown in the dialog were appended; askpass never accepts yes.
});
