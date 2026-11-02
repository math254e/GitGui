import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { alignReleaseVersions, crateFiles, packageFiles, releaseTagVersion, releaseVersion, workspaceRoot } from "./release-versions.mjs";

const json = async (file) => JSON.parse(await readFile(file, "utf8"));
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "gitgui-versions-test-"));
  try {
    for (const file of [...await packageFiles(workspaceRoot), ...crateFiles, "package-lock.json", "Cargo.lock", "Cargo.toml"]) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await cp(join(workspaceRoot, file), join(root, file));
    }
    for (const file of crateFiles) {
      const source = join(root, dirname(file), "src");
      await mkdir(source);
      await writeFile(join(source, "lib.rs"), "");
      if (file.includes("gitgui-server")) await writeFile(join(source, "main.rs"), "fn main() {}\n");
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("accepts stable release versions and rejects invalid/channel/shell input", () => {
  assert.equal(releaseVersion("v1.2.3"), "1.2.3");
  for (const version of ["", " 1.2.3", "01.2.3", "1.2", "1.2.3-beta.1", "1.2.3+build", "1.2.3\n", "1.2.3; echo x", "65536.0.0", undefined]) {
    assert.throws(() => releaseVersion(version));
  }
});

test("derives release versions only from new stable tag pushes", () => {
  const event = { eventName: "push", ref: "refs/tags/v12.34.56", created: true, deleted: false, forced: false };
  assert.equal(releaseTagVersion(event), "12.34.56");
  for (const change of [
    { eventName: "workflow_dispatch" }, { eventName: "pull_request" }, { eventName: "schedule" },
    { created: false }, { deleted: true }, { forced: true }, { created: undefined },
    { ref: "refs/heads/v12.34.56" }, { ref: "refs/tags/12.34.56" },
    { ref: "refs/tags/v01.2.3" }, { ref: "refs/tags/v1.2.3-beta.1" },
    { ref: "refs/tags/v1.2.3+build" }, { ref: "refs/tags/v65536.0.0" },
    { ref: "refs/tags/v1.2.3\n" }, { ref: "refs/tags/v1.2.3; echo x" },
  ]) assert.throws(() => releaseTagVersion({ ...event, ...change }));
});

test("aligns every npm/Cargo package and both locks without changing external versions", () => fixture(async (root) => {
  const beforeNpm = await json(join(root, "package-lock.json"));
  const beforeCargo = await readFile(join(root, "Cargo.lock"), "utf8");
  const result = await alignReleaseVersions("v12.34.56", { root });
  assert(result.changed.includes("Cargo.lock"));
  const lock = await json(join(root, "package-lock.json"));
  assert.equal(lock.version, "12.34.56");
  for (const file of await packageFiles(root)) {
    const manifest = await json(join(root, file));
    assert.equal(manifest.version, "12.34.56");
    const key = file === "package.json" ? "" : file.replace(/\/package.json$/, "");
    assert.equal(lock.packages[key].version, manifest.version);
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      assert.deepEqual(lock.packages[key][field], manifest[field]);
      for (const [name, version] of Object.entries(manifest[field] ?? {})) {
        if (name.startsWith("@gitgui/")) assert.equal(version, "12.34.56");
      }
    }
  }
  for (const [key, entry] of Object.entries(beforeNpm.packages)) {
    if (key.includes("node_modules/")) assert.deepEqual(lock.packages[key], entry);
  }
  const cargo = await readFile(join(root, "Cargo.lock"), "utf8");
  const external = (text) => text.split("[[package]]").filter((block) => /^source = /m.test(block));
  assert.deepEqual(external(cargo), external(beforeCargo));
  const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--no-deps", "--locked", "--format-version", "1"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  assert.equal(metadata.packages.length, crateFiles.length);
  assert(metadata.packages.every((pkg) => pkg.version === "12.34.56"));
  assert.deepEqual(await alignReleaseVersions("12.34.56", { root, check: true }), { version: "12.34.56", changed: [] });
  assert.deepEqual((await alignReleaseVersions("12.34.56", { root })).changed, []);
}));

test("injected npm workspace lock is accepted by npm ci", () => fixture(async (root) => {
  await alignReleaseVersions("2.3.4", { root });
  assert(process.env.npm_execpath, "Run tests using npm run release:test");
  execFileSync(process.execPath, [process.env.npm_execpath, "ci", "--dry-run", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"], {
    cwd: root, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"],
  });
}));

test("check mode detects workspace-lock dependency drift and never writes", () => fixture(async (root) => {
  await alignReleaseVersions("2.0.0", { root });
  const lockFile = join(root, "package-lock.json");
  const lock = await json(lockFile);
  lock.packages["apps/desktop"].dependencies["@gitgui/ssh"] = "0.0.1";
  const before = JSON.stringify(lock);
  await writeFile(lockFile, before);
  await assert.rejects(alignReleaseVersions("2.0.0", { root, check: true }), /package-lock.json/);
  assert.equal(await readFile(lockFile, "utf8"), before);
}));

test("missing Cargo lock package fails before writing any planned versions", () => fixture(async (root) => {
  const packageBefore = await readFile(join(root, "package.json"), "utf8");
  const lock = await readFile(join(root, "Cargo.lock"), "utf8");
  await writeFile(join(root, "Cargo.lock"), lock.replace('name = "gitgui-core"', 'name = "missing-core"'));
  await assert.rejects(alignReleaseVersions("9.0.0", { root }), /missing a local workspace package/);
  assert.equal(await readFile(join(root, "package.json"), "utf8"), packageBefore);
}));
