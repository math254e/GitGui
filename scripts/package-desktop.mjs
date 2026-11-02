import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { alignReleaseVersions, releaseVersion, workspaceRoot as root } from "./release-versions.mjs";
import { stageDesktop } from "./stage-desktop.mjs";
import { validateDesktopArtifacts } from "./validate-desktop-artifacts.mjs";
import { verifyPackagedDesktop } from "./verify-packaged-desktop.mjs";
import { yaml } from "./desktop-release-tools.mjs";

const require = createRequire(import.meta.url);

function run(command, args, env = process.env) {
  console.log(`[desktop-package] ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit", windowsHide: true, shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Build step failed (${result.status}): ${command}`);
}

async function main() {
  const { values } = parseArgs({ options: {
    platform: { type: "string" }, target: { type: "string" }, version: { type: "string" }, "output-dir": { type: "string" },
  } });
  const host = { win32: "win", linux: "linux" }[process.platform];
  const platform = values.platform ?? host;
  if (!host || platform !== host || process.arch !== "x64") throw new Error("Package on the matching Windows x64 or Linux x64 host");
  const target = values.target ?? (platform === "win" ? "nsis" : "AppImage");
  if (!(platform === "win" ? ["nsis"] : ["AppImage", "deb"]).includes(target)) throw new Error(`Unsupported ${platform} target: ${target}`);
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const version = releaseVersion(values.version ?? manifest.version);
  await alignReleaseVersions(version, { check: true });
  if (!process.env.npm_execpath) throw new Error("Run this helper through npm run electron:package");
  run("git", ["--version"]);

  // Never reuse output or package stale compiled modules after a source deletion.
  const output = resolve(root, values["output-dir"] ?? `release/${version}/${platform}-${target}-x64`);
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  for (const directory of ["apps/desktop/dist", "packages/ssh/dist"]) {
    const path = resolve(root, directory);
    if (path !== join(root, ...directory.split("/"))) throw new Error("Invalid build output path");
    await rm(path, { recursive: true, force: true });
  }
  run(process.execPath, [join(root, "scripts/prepare-gitgui-server.mjs"), "--release"]);
  run(process.execPath, [process.env.npm_execpath, "run", "build"]);
  run(process.execPath, [process.env.npm_execpath, "run", "desktop:build"]);

  const temporary = await mkdtemp(join(tmpdir(), "gitgui-desktop-stage-"));
  try {
    const appDirectory = join(temporary, "app");
    await stageDesktop(root, appDirectory);
    // Extra resource matchers are project-relative, not relative to directories.app.
    // Use an isolated project with explicit absolute inputs to avoid that ambiguity.
    const config = yaml.load(await readFile(join(root, "apps/desktop/electron-builder.yml"), "utf8"));
    config.directories = { app: appDirectory, output, buildResources: join(root, "apps/desktop/build") };
    config.extraResources = [
      { from: join(root, "apps/web/build"), to: "web" },
      { from: join(root, "apps/desktop/resources/server"), to: "server", filter: [platform === "win" ? "gitgui-server.exe" : "gitgui-server"] },
    ];
    config.electronVersion = require("electron/package.json").version;
    const configFile = join(temporary, "electron-builder.json");
    await writeFile(configFile, JSON.stringify(config, null, 2));
    const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" };
    for (const name of ["CSC_LINK", "CSC_KEY_PASSWORD", "WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD", "GH_TOKEN", "GITHUB_TOKEN"]) delete env[name];
    run(process.execPath, [require.resolve("electron-builder/cli.js"), "--projectDir", temporary,
      "--config", configFile, `--${platform}`, target, "--x64", "--publish", "never"], env);
    await verifyPackagedDesktop(join(output, platform === "win" ? "win-unpacked" : "linux-unpacked"), version, platform);
    // Workflow uploads only these final files. Unpacked payloads remain local for inspection.
    const artifacts = target === "deb" ? [`GitGui-${version}-linux-x64.deb`] :
      await validateDesktopArtifacts({ directory: output, version, platform });
    const publishDirectory = join(output, "artifacts");
    await mkdir(publishDirectory);
    for (const name of artifacts) await cp(join(output, name), join(publishDirectory, name));
    console.log(`[desktop-package] Verified artifacts: ${publishDirectory}`);
  } finally {
    // This path is the exact temporary stage created above, never a caller-selected directory.
    await rm(temporary, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
}
