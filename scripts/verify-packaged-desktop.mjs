import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asar, yaml } from "./desktop-release-tools.mjs";

export async function verifyPackagedDesktop(directory, version, platform) {
  const resources = join(directory, "resources");
  const config = yaml.load(await readFile(join(resources, "app-update.yml"), "utf8"), { schema: yaml.JSON_SCHEMA });
  assert.equal(config.provider, "github");
  assert.equal(config.owner, "math254e");
  assert.equal(config.repo, "GitGui");
  assert.equal(config.channel, "latest");
  assert.equal(config.token, undefined, "Updater config must not contain credentials");
  const backend = join(resources, "server", platform === "win" ? "gitgui-server.exe" : "gitgui-server");
  assert.equal(execFileSync(backend, ["--version"], { encoding: "utf8", timeout: 30_000, windowsHide: true }).trim(), `gitgui-server ${version}`);
  assert((await stat(join(resources, "web/index.html"))).size > 0, "Missing production web app");

  // Extract outside the workspace so imports cannot fall back to development node_modules.
  const isolated = await mkdtemp(join(tmpdir(), "gitgui-package-smoke-"));
  try {
    asar.extractAll(join(resources, "app.asar"), isolated);
    const manifest = JSON.parse(await readFile(join(isolated, "package.json"), "utf8"));
    assert.equal(manifest.version, version);
    assert((await stat(join(isolated, manifest.main))).size > 0);
    for (const name of ["ssh", "contracts"]) {
      const workspace = JSON.parse(await readFile(join(isolated, `node_modules/@gitgui/${name}/package.json`), "utf8"));
      assert.equal(workspace.version, version, `Packaged ${name} version must match the app`);
    }
    assert((await stat(join(isolated, "node_modules/@gitgui/contracts/src/desktop.ts"))).size > 0);
    await writeFile(join(isolated, "smoke.mjs"), `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      import { SshEnvironmentManager } from '@gitgui/ssh';
      const require = createRequire(import.meta.url);
      assert.equal(typeof SshEnvironmentManager, 'function');
      assert.equal(typeof require('electron-updater').NsisUpdater, 'function');
    `);
    execFileSync(process.execPath, [join(isolated, "smoke.mjs")], {
      cwd: isolated, env: { ...process.env, NODE_PATH: "" }, stdio: "pipe", timeout: 30_000, windowsHide: true,
    });
  } finally {
    // Only remove the exact temporary extraction created above.
    await rm(isolated, { recursive: true, force: true });
  }
  console.log(`Packaged ${platform}/x64 backend ${version}, web, updater config, SSH, and updater dependencies verified`);
}
