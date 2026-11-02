import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const workspaceRoot = resolve(import.meta.dirname, "..");
export const crateFiles = [
  "crates/gitgui-core/Cargo.toml",
  "crates/gitgui-protocol/Cargo.toml",
  "crates/gitgui-server/Cargo.toml",
];
const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

// Only the stable channel is supported by this first release workflow.
export function releaseVersion(input) {
  if (typeof input !== "string" || !/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(input)) {
    throw new Error("Expected a stable version such as 1.2.3 (optionally prefixed with v)");
  }
  const version = input.replace(/^v/, "");
  if (version.split(".").some((part) => Number(part) > 65535)) {
    throw new Error("Version components must be at most 65535 for Windows packaging");
  }
  return version;
}

// Treat the webhook as a boundary: moving/deleting a tag is not a new release.
export function releaseTagVersion({ eventName, ref, created, deleted, forced }) {
  if (eventName !== "push" || created !== true || deleted !== false || forced !== false
    || typeof ref !== "string" || !ref.startsWith("refs/tags/v")) {
    throw new Error("Desktop releases require a newly created stable vX.Y.Z tag push");
  }
  return releaseVersion(ref.slice("refs/tags/".length));
}

export async function packageFiles(root) {
  const files = ["package.json"];
  for (const directory of ["apps", "packages"]) {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      if (entry.isDirectory()) files.push(`${directory}/${entry.name}/package.json`);
    }
  }
  return files;
}

export async function alignReleaseVersions(input, { root = workspaceRoot, check = false } = {}) {
  const version = releaseVersion(input);
  const files = await packageFiles(root);
  const manifests = new Map(await Promise.all(files.map(async (file) =>
    [file, JSON.parse(await readFile(join(root, file), "utf8"))])));
  const names = new Set([...manifests.values()].map((manifest) => manifest.name));
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  if (lock.lockfileVersion !== 3 || !lock.packages) throw new Error("Expected npm lockfile version 3");

  // Plan every edit before writing, so malformed input cannot leave a partial bump.
  const changes = new Map();
  const planJson = async (file, value) => {
    const before = await readFile(join(root, file), "utf8");
    if (JSON.stringify(JSON.parse(before)) !== JSON.stringify(value)) {
      changes.set(file, `${JSON.stringify(value, null, 2)}\n`);
    }
  };
  lock.version = version;
  for (const [file, manifest] of manifests) {
    manifest.version = version;
    for (const field of dependencyFields) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        if (names.has(name)) manifest[field][name] = version;
      }
    }
    await planJson(file, manifest);
    const key = file === "package.json" ? "" : file.replace(/\/package\.json$/, "");
    const locked = lock.packages[key];
    if (!locked || locked.link) throw new Error(`Missing workspace lock entry: ${key}`);
    if (key) {
      const link = lock.packages[`node_modules/${manifest.name}`];
      if (!link?.link || link.resolved !== key) throw new Error(`Invalid npm workspace link: ${manifest.name}`);
    }
    locked.version = version;
    for (const field of dependencyFields) {
      if (manifest[field]) locked[field] = { ...manifest[field] };
      else delete locked[field];
    }
  }
  await planJson("package-lock.json", lock);

  const crates = new Map();
  for (const file of crateFiles) {
    const before = await readFile(join(root, file), "utf8");
    const section = before.match(/\[package\][^]*?(?=\r?\n\[|$)/)?.[0];
    const name = section?.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    const oldVersion = section?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    if (!name || !oldVersion) throw new Error(`Missing explicit Cargo package version: ${file}`);
    crates.set(name, oldVersion);
    const after = before.replace(section, section.replace(/^(version\s*=\s*)"[^"]+"/m, `$1"${version}"`));
    if (before !== after) changes.set(file, after);
  }
  const cargoLock = await readFile(join(root, "Cargo.lock"), "utf8");
  const seen = new Set();
  let updatedLock = cargoLock.replace(/\[\[package\]\][^]*?(?=\r?\n\[\[package\]\]|$)/g, (block) => {
    const name = block.match(/^name = "([^"]+)"/m)?.[1];
    if (!crates.has(name) || /^source = /m.test(block)) return block;
    if (seen.has(name)) throw new Error(`Duplicate local Cargo lock package: ${name}`);
    seen.add(name);
    return block.replace(/^version = "[^"]+"/m, `version = "${version}"`);
  });
  if (seen.size !== crates.size) throw new Error("Cargo.lock is missing a local workspace package");
  for (const [name, previous] of crates) {
    updatedLock = updatedLock.replaceAll(`"${name} ${previous}"`, `"${name} ${version}"`);
  }
  if (updatedLock !== cargoLock) changes.set("Cargo.lock", updatedLock);
  if (check && changes.size) throw new Error(`Release versions/locks disagree with ${version}: ${[...changes.keys()].join(", ")}`);
  if (!check) {
    for (const [file, contents] of changes) await writeFile(join(root, file), contents);
  }
  return { version, changed: [...changes.keys()] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const check = args[0] === "--check";
    if (check) args.shift();
    if (args.length !== 1) throw new Error("Usage: node scripts/release-versions.mjs [--check] <version>");
    const result = await alignReleaseVersions(args[0], { check });
    console.log(`Release ${result.version}: ${check ? "versions and locks aligned" : `${result.changed.length} files updated`}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
