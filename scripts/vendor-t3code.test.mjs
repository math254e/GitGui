import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "gitgui-vendor-test-"));
  try {
    const upstream = join(root, "upstream");
    await mkdir(upstream);
    await mkdir(join(root, "scripts"));
    const git = (...args) => execFileSync("git", ["-C", upstream, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init");
    await writeFile(join(upstream, "source.ts"), "export const upstream = true;\n");
    git("add", "source.ts");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture");
    const commit = git("rev-parse", "HEAD");
    await copyFile(new URL("./vendor-t3code.mjs", import.meta.url), join(root, "scripts/vendor-t3code.mjs"));
    const header = `/**\n * Vendored from T3 Code (\`source.ts\`).\n * Upstream: t3code @ ${commit}\n */\n`;
    const manifest = {
      upstream: { repository: "fixture", commit, tag: "fixture", defaultCheckout: upstream },
      files: [
        { upstream: "source.ts", target: "adapted.ts", mode: "adapted" },
        { upstream: "source.ts", target: "verbatim.ts", mode: "verbatim" },
      ],
    };
    await writeFile(join(root, "scripts/t3code-vendored.json"), JSON.stringify(manifest));
    await writeFile(join(root, "adapted.ts"), `${header}export const adapted = true;\n`);
    await writeFile(join(root, "verbatim.ts"), `${header}export const upstream = true;\n`);
    const check = (...args) => spawnSync(process.execPath, [join(root, "scripts/vendor-t3code.mjs"), ...args], { encoding: "utf8", env: { ...process.env, T3CODE_PATH: upstream } });
    assert.equal(check("--record-adaptations").status, 0);
    await run({ root, upstream, check });
  } finally {
    // Only the exact directory created by this fixture is removed.
    await rm(root, { recursive: true, force: true });
  }
}

test("accepts reviewed adaptations and rejects subsequent adapted body changes", () => fixture(async ({ root, check }) => {
  assert.equal(check().status, 0);
  await writeFile(join(root, "adapted.ts"), (await readFile(join(root, "adapted.ts"), "utf8")) + "arbitrary invalid body\n");
  const result = check();
  assert.equal(result.status, 1);
  assert.match(result.stdout, /adapted.ts.*drifted/);
}));

test("rejects dirty upstream files even when recording adaptations", () => fixture(async ({ upstream, check }) => {
  await writeFile(join(upstream, "source.ts"), "unreviewed upstream\n");
  assert.equal(check().status, 1);
  assert.equal(check("--record-adaptations").status, 1);
}));

test("verbatim drift fails and --write restores its body while preserving provenance", () => fixture(async ({ root, check }) => {
  const path = join(root, "verbatim.ts");
  const original = await readFile(path, "utf8");
  await writeFile(path, original + "drift\n");
  assert.equal(check().status, 1);
  assert.equal(check("--write").status, 1);
  assert.equal(await readFile(path, "utf8"), original);
  assert.equal(check().status, 0);
}));

test("rejects missing provenance even when the adapted hash is recorded", () => fixture(async ({ root, check }) => {
  await writeFile(join(root, "adapted.ts"), "export const adapted = true;\n");
  assert.equal(check("--record-adaptations").status, 1);
}));
