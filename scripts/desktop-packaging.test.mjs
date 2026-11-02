import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { deflateRawSync, gzipSync, gunzipSync } from "node:zlib";
import { blake2b, yaml } from "./desktop-release-tools.mjs";
import { stageDesktop } from "./stage-desktop.mjs";
import { validateDesktopArtifacts } from "./validate-desktop-artifacts.mjs";

const require = createRequire(import.meta.url);
const { buildBlockMap } = require("app-builder-lib/out/targets/blockmap/blockmap.js");
const { expandMacro } = require("app-builder-lib/out/util/macroExpander.js");
const { Arch, getArtifactArchName } = require("builder-util");
const version = "2.3.4";
const win = `GitGui-${version}-win-x64.exe`;
const linux = `GitGui-${version}-linux-x64.AppImage`;
async function temporary(run) {
  const directory = await mkdtemp(join(tmpdir(), "gitgui-packaging-test-"));
  try { await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
const validate = (directory, platform = "win") => validateDesktopArtifacts({ directory, version, platform });
async function fixture(directory, platform = "win") {
  const name = platform === "win" ? win : linux;
  const path = join(directory, name);
  await writeFile(path, Buffer.concat([platform === "win" ? Buffer.from("MZ") : Buffer.from([0x7f, 0x45, 0x4c, 0x46]), randomBytes(120_000)]));
  const info = await buildBlockMap(path, platform === "win" ? "gzip" : "deflate", platform === "win" ? `${path}.blockmap` : undefined);
  const metadata = { version, files: [{ url: name, ...info }], path: name, sha512: info.sha512 };
  await metadataWrite(directory, platform, metadata);
  return metadata;
}
const metadataWrite = (directory, platform, metadata) => writeFile(join(directory, platform === "win" ? "latest.yml" : "latest-linux.yml"), yaml.dump(metadata));

test("release configuration keeps publication explicit and restricts the supported targets", async () => {
  const workflow = yaml.load(await readFile(new URL("../.github/workflows/desktop-release.yml", import.meta.url), "utf8"));
  assert.deepEqual(workflow.on, { push: { tags: ["v[0-9]+.[0-9]+.[0-9]+"] } });
  assert.match(workflow.jobs.validate.if, /github\.event_name == 'push'/);
  assert.match(workflow.jobs.validate.if, /github\.ref_type == 'tag'/);
  assert.match(workflow.jobs.validate.if, /github\.event\.created == true/);
  assert.match(workflow.jobs.validate.if, /github\.event\.deleted == false/);
  assert.match(workflow.jobs.validate.if, /github\.event\.forced == false/);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.match(workflow.jobs.publish.if, /vars\.GITGUI_PUBLISH_RELEASES == 'true'/);
  assert.match(workflow.jobs.publish.if, /github\.repository == 'math254e\/GitGui'/);
  assert.deepEqual(workflow.jobs.publish.permissions, { contents: "write" });
  assert.deepEqual(workflow.jobs.publish.needs, ["validate", "build"]);
  assert.deepEqual(workflow.jobs.build.strategy.matrix.include.map((entry) => entry.platform), ["win", "linux"]);
  for (const job of Object.values(workflow.jobs)) {
    const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    assert.equal(checkout.with.ref, "${{ github.sha }}");
    assert.equal(checkout.with["persist-credentials"], false);
    for (const step of job.steps) {
      if (step.uses?.startsWith("actions/")) {
        const [action, ref] = step.uses.split("@");
        assert.equal(ref, action === "actions/download-artifact" ? "v8" : "v7");
      }
    }
  }
  const config = yaml.load(await readFile(new URL("../apps/desktop/electron-builder.yml", import.meta.url), "utf8"));
  assert.equal(config.appId, "dev.gitgui.desktop");
  assert.deepEqual(config.publish, { provider: "github", owner: "math254e", repo: "GitGui", channel: "latest", releaseType: "release" });
  assert.equal(config.mac, undefined);
  assert.equal(config.win.signExecutable, false);
  assert.equal(config.win.verifyUpdateCodeSignature, false);
  assert.deepEqual(config.win.target, [{ target: "nsis", arch: ["x64"] }]);
  assert.deepEqual(config.linux.target, [{ target: "AppImage", arch: ["x64"] }]);
});

test("electron-builder filename expansion matches the x64 release contract on both platforms", async () => {
  const config = yaml.load(await readFile(new URL("../apps/desktop/electron-builder.yml", import.meta.url), "utf8"));
  for (const [os, ext] of [["win", "exe"], ["linux", "AppImage"], ["linux", "deb"]]) {
    // Use the real builder macro/architecture mapping: AppImage maps x64 to
    // x86_64 and DEB maps it to amd64 even on a Windows validation host.
    const arch = getArtifactArchName(Arch.x64, ext);
    assert.equal(expandMacro(config.artifactName, arch, { version }, { os, ext }), `GitGui-${version}-${os}-x64.${ext}`);
  }
});

test("publication uses the existing tag and stops before publishing incomplete or mismatched releases", async () => {
  const workflow = yaml.load(await readFile(new URL("../.github/workflows/desktop-release.yml", import.meta.url), "utf8"));
  const script = workflow.jobs.publish.steps.at(-1).run;
  const bash = process.platform === "win32" ? join(process.env.ProgramFiles ?? "C:/Program Files", "Git/bin/bash.exe") : "bash";
  // Exercise the workflow's real shell block; intercept every gh call so this
  // test can never create a release or make a network request.
  const mock = `
    gh() {
      case "$1 $2" in
        'release view') [[ "$SCENARIO" == existing ]] ;;
        'api repos/math254e/GitGui/commits/refs%2Ftags%2Fv2.3.4')
          [[ "$SCENARIO" != missing ]] || return 1
          if [[ "$SCENARIO" == moved ]]; then echo another-commit; else echo built-commit; fi ;;
        'release create') echo "CREATE: $*" >&2; [[ "$SCENARIO" != upload-failure ]] ;;
        'release edit') echo "PUBLISH: $*" >&2 ;;
        *) echo "Unexpected gh call: $*" >&2; return 99 ;;
      esac
    }
  `;
  for (const scenario of ["success", "existing", "missing", "moved", "upload-failure"]) {
    const result = spawnSync(bash, ["--noprofile", "--norc", "-s"], {
      input: `${mock}\n${script}`, encoding: "utf8", timeout: 10_000,
      env: { ...process.env, BASH_ENV: "", SCENARIO: scenario, GH_REPO: "math254e/GitGui", RELEASE_VERSION: "2.3.4", RELEASE_COMMIT: "built-commit" },
    });
    assert.ifError(result.error);
    if (scenario === "success") {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /CREATE: .*--verify-tag.*--draft/);
      assert.doesNotMatch(result.stderr, /--target/);
      assert.match(result.stderr, /PUBLISH: .*--draft=false --latest/);
    } else {
      assert.notEqual(result.status, 0, scenario);
      assert.doesNotMatch(result.stderr, /PUBLISH:/, scenario);
      if (scenario !== "upload-failure") assert.doesNotMatch(result.stderr, /CREATE:/, scenario);
    }
  }
});

test("accepts real electron-builder external and embedded blockmaps and combined assets", () => temporary(async (directory) => {
  await fixture(directory);
  assert.deepEqual(await validate(directory), [win, `${win}.blockmap`, "latest.yml"]);
  await fixture(directory, "linux");
  assert.equal((await validate(directory, "all")).length, 5);
}));

test("rejects metadata version, size, digest, remote URL, and traversal mismatches", () => temporary(async (directory) => {
  const valid = await fixture(directory);
  for (const mutate of [
    (m) => { m.version = "1.0.0"; },
    (m) => { m.files[0].size++; },
    (m) => { m.sha512 = "wrong"; },
    (m) => { m.files[0].sha512 = "wrong"; },
    (m) => { m.files[0].url = "https://example.com/payload.exe"; },
    (m) => { m.files[0].url = "../payload.exe"; },
  ]) {
    const invalid = structuredClone(valid);
    mutate(invalid);
    await metadataWrite(directory, "win", invalid);
    await assert.rejects(validate(directory));
  }
}));

test("rejects damaged payloads and missing or corrupt NSIS blockmaps", () => temporary(async (directory) => {
  await fixture(directory);
  const blockmap = join(directory, `${win}.blockmap`);
  await rm(blockmap);
  await assert.rejects(validate(directory), /ENOENT/);
  await writeFile(blockmap, "not gzip");
  await assert.rejects(validate(directory));
  await fixture(directory);
  const map = JSON.parse(gunzipSync(await readFile(blockmap)).toString());
  map.files[0].checksums[0] = Buffer.alloc(18).toString("base64");
  await writeFile(blockmap, gzipSync(JSON.stringify(map)));
  await assert.rejects(validate(directory), /Blockmap checksum mismatch/);
  await fixture(directory);
  const payload = await readFile(join(directory, win));
  payload[20] ^= 0xff;
  await writeFile(join(directory, win), payload);
  await assert.rejects(validate(directory), /SHA-512 mismatch/);
}));

test("rejects stale output and symlinked artifacts", () => temporary(async (directory) => {
  await fixture(directory);
  await writeFile(join(directory, "old-installer.exe"), "old");
  await assert.rejects(validate(directory), /Unexpected release asset/);
  await rm(join(directory, "old-installer.exe"));
  // File symlinks require special privileges on Windows; directory junctions
  // are tested below, and Linux exercises the untrusted artifact symlink case.
  if (process.platform !== "win32") {
    await rm(join(directory, win));
    await symlink(join(directory, `${win}.blockmap`), join(directory, win));
    await assert.rejects(validate(directory), /regular artifact file/);
  }
}));

test("requires correct AppImage blockmap trailer, coverage, and chunk checksums", () => temporary(async (directory) => {
  const metadata = await fixture(directory, "linux");
  delete metadata.files[0].blockMapSize;
  await metadataWrite(directory, "linux", metadata);
  await assert.rejects(validate(directory, "linux"), /blockmap size/);
  const payload = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), randomBytes(100)]);
  for (const badChecksum of [false, true]) {
    const size = badChecksum ? payload.length : payload.length - 1;
    const checksum = Buffer.from(blake2b(payload.subarray(0, size), { dkLen: 18 })).toString("base64");
    const map = { version: "2", files: [{ name: "file", offset: 0, sizes: [size], checksums: [badChecksum ? "wrong" : checksum] }] };
    const compressed = deflateRawSync(JSON.stringify(map));
    const trailer = Buffer.alloc(4);
    trailer.writeUInt32BE(compressed.length);
    const artifact = Buffer.concat([payload, compressed, trailer]);
    await writeFile(join(directory, linux), artifact);
    const sha512 = createHash("sha512").update(artifact).digest("base64");
    const m = { version, files: [{ url: linux, size: artifact.length, sha512, blockMapSize: compressed.length }], path: linux, sha512 };
    await metadataWrite(directory, "linux", m);
    await assert.rejects(validate(directory, "linux"), badChecksum ? /checksum mismatch/ : /does not cover/);
    artifact.writeUInt32BE(compressed.length + 1, artifact.length - 4);
    await writeFile(join(directory, linux), artifact);
    m.sha512 = m.files[0].sha512 = createHash("sha512").update(artifact).digest("base64");
    await metadataWrite(directory, "linux", m);
    await assert.rejects(validate(directory, "linux"), /trailer/);
  }
}));

test("materializes workspace junctions and nested dependency versions outside the repository", () => temporary(async (base) => {
  const root = join(base, "repository");
  const stage = join(base, "isolated");
  const packages = {
    "apps/desktop": { name: "@gitgui/desktop", version: "1.0.0", main: "dist/main.js", type: "module", dependencies: { "@gitgui/ssh": "1.0.0", shared: "1.0.0" } },
    "packages/ssh": { name: "@gitgui/ssh", version: "1.0.0", main: "dist/index.js", type: "module", dependencies: { shared: "2.0.0", "@gitgui/contracts": "1.0.0" } },
    "packages/contracts": { name: "@gitgui/contracts", version: "1.0.0" },
    "node_modules/shared": { name: "shared", version: "1.0.0", main: "index.cjs" },
    "packages/ssh/node_modules/shared": { name: "shared", version: "2.0.0", main: "index.cjs" },
  };
  for (const [key, pkg] of Object.entries(packages)) {
    await mkdir(join(root, key), { recursive: true });
    await writeFile(join(root, key, "package.json"), JSON.stringify(pkg));
  }
  await writeFile(join(root, "package-lock.json"), JSON.stringify({ packages }));
  await mkdir(join(root, "apps/desktop/dist"));
  await writeFile(join(root, "apps/desktop/dist/main.js"), "");
  await mkdir(join(root, "packages/ssh/dist"));
  await writeFile(join(root, "packages/ssh/dist/index.js"), "import value from 'shared'; export default value;\n");
  await writeFile(join(root, "node_modules/shared/index.cjs"), "module.exports = 1;");
  await writeFile(join(root, "packages/ssh/node_modules/shared/index.cjs"), "module.exports = 2;");
  await mkdir(join(root, "node_modules/@gitgui"));
  for (const name of ["ssh", "contracts"]) await symlink(join(root, `packages/${name}`), join(root, `node_modules/@gitgui/${name}`), "junction");
  await stageDesktop(root, stage);
  assert(!(await lstat(join(stage, "node_modules/@gitgui/ssh"))).isSymbolicLink());
  assert((await lstat(join(stage, "node_modules/@gitgui/ssh/node_modules/@gitgui/contracts/package.json"))).isFile());
  await writeFile(join(root, "node_modules/shared/package.json"), JSON.stringify({ ...packages["node_modules/shared"], version: "9.0.0" }));
  await assert.rejects(stageDesktop(root, join(base, "bad-version")), /disagrees with npm lock/);
  await rm(join(root, "node_modules/shared"), { recursive: true });
  await assert.rejects(stageDesktop(root, join(base, "missing-dependency")), /Missing production dependency/);
  // Delete the repository before resolving imports to prove no workspace fallback.
  await rm(root, { recursive: true, force: true });
  await writeFile(join(stage, "smoke.mjs"), "import assert from 'node:assert/strict'; import ssh from '@gitgui/ssh'; import value from 'shared'; assert.equal(ssh, 2); assert.equal(value, 1);\n");
  execFileSync(process.execPath, [join(stage, "smoke.mjs")], { cwd: stage, env: { ...process.env, NODE_PATH: "" }, stdio: "pipe" });
}));
