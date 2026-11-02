import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { blake2b, yaml } from "./desktop-release-tools.mjs";
import { releaseVersion } from "./release-versions.mjs";

function insist(condition, message) {
  if (!condition) throw new Error(message);
}

async function regularFile(directory, name) {
  insist(typeof name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name), `Unsafe artifact path: ${name}`);
  const path = join(directory, name);
  insist((await lstat(path)).isFile(), `Expected a regular artifact file: ${name}`);
  return await readFile(path);
}

function validateBlockmap(compressed, payload, embedded) {
  const decoded = embedded
    ? inflateRawSync(compressed, { maxOutputLength: 16 * 1024 * 1024 })
    : gunzipSync(compressed, { maxOutputLength: 16 * 1024 * 1024 });
  const map = JSON.parse(decoded.toString("utf8"));
  insist(map.version === "2" && map.files?.length === 1, "Invalid blockmap format");
  const file = map.files[0];
  insist(file.offset === 0 && Array.isArray(file.sizes) && file.sizes.length > 0 &&
    Array.isArray(file.checksums) && file.sizes.length === file.checksums.length, "Invalid blockmap chunks");
  let offset = 0;
  for (let index = 0; index < file.sizes.length; index++) {
    const size = file.sizes[index];
    insist(Number.isSafeInteger(size) && size > 0 && offset + size <= payload.length, "Invalid blockmap chunk size");
    const checksum = Buffer.from(blake2b(payload.subarray(offset, offset + size), { dkLen: 18 })).toString("base64");
    insist(file.checksums[index] === checksum, `Blockmap checksum mismatch at chunk ${index}`);
    offset += size;
  }
  insist(offset === payload.length, "Blockmap does not cover the artifact payload");
}

export async function validateDesktopArtifacts({ directory, version: input, platform }) {
  const version = releaseVersion(input);
  insist(["win", "linux", "all"].includes(platform), "Expected platform win, linux, or all");
  const platforms = platform === "all" ? ["win", "linux"] : [platform];
  const assets = [];
  for (const os of platforms) {
    const metadataName = os === "win" ? "latest.yml" : "latest-linux.yml";
    const metadata = yaml.load((await regularFile(directory, metadataName)).toString("utf8"), { schema: yaml.JSON_SCHEMA });
    insist(metadata?.version === version, `Wrong version in ${metadataName}`);
    insist(Array.isArray(metadata.files) && metadata.files.length === 1, `Expected one x64 update payload in ${metadataName}`);
    const info = metadata.files[0];
    const expected = `GitGui-${version}-${os}-x64.${os === "win" ? "exe" : "AppImage"}`;
    insist(info.url === expected && metadata.path === expected, `Unexpected update artifact in ${metadataName}`);
    const data = await regularFile(directory, info.url);
    insist(data.length > 0 && info.size === data.length, `Artifact size mismatch: ${info.url}`);
    const sha512 = createHash("sha512").update(data).digest("base64");
    insist(info.sha512 === sha512 && metadata.sha512 === sha512, `Artifact SHA-512 mismatch: ${info.url}`);
    if (os === "win") {
      insist(data.subarray(0, 2).toString() === "MZ", "Windows payload is not a PE executable");
      const blockmapName = `${expected}.blockmap`;
      validateBlockmap(await regularFile(directory, blockmapName), data, false);
      assets.push(expected, blockmapName, metadataName);
    } else {
      insist(data.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), "Linux payload is not an ELF AppImage");
      const size = info.blockMapSize;
      insist(Number.isSafeInteger(size) && size > 0 && size < data.length - 4, "Missing embedded AppImage blockmap size");
      insist(data.readUInt32BE(data.length - 4) === size, "Embedded AppImage blockmap trailer disagrees with metadata");
      const start = data.length - size - 4;
      validateBlockmap(data.subarray(start, data.length - 4), data.subarray(0, start), true);
      assets.push(expected, metadataName);
    }
  }
  // Reject stray channel/manifests/installers rather than accidentally publishing stale output.
  const releaseFiles = (await readdir(directory)).filter((name) => /\.(yml|exe|AppImage|blockmap|deb|dmg|zip)$/.test(name));
  for (const name of releaseFiles) {
    if (name === "builder-debug.yml" || name === "builder-effective-config.yaml") continue;
    insist(assets.includes(name), `Unexpected release asset: ${name}`);
  }
  return assets;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [directory, version, platform, ...extra] = process.argv.slice(2);
    if (!directory || !version || !platform || extra.length) throw new Error("Usage: node scripts/validate-desktop-artifacts.mjs <directory> <version> <win|linux|all>");
    const assets = await validateDesktopArtifacts({ directory: resolve(directory), version, platform });
    console.log(`Validated release assets:\n${assets.join("\n")}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
