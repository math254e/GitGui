import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const release = process.argv.includes("--release");
const dryRun = process.argv.includes("--dry-run");
const unknown = process.argv.slice(2).filter((value) => value !== "--release" && value !== "--dry-run");
if (unknown.length) fail(`Unknown argument: ${unknown[0]}`);

const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--no-deps", "--format-version", "1", "--locked"], {
  cwd: root,
  encoding: "utf8",
}));
const executableName = process.platform === "win32" ? "gitgui-server.exe" : "gitgui-server";
const profile = release ? "release" : "debug";
const source = join(metadata.target_directory, profile, executableName);
const destination = join(root, "apps", "desktop", "resources", "server", executableName);
const args = ["build", "-p", "gitgui-server", "--locked", ...(release ? ["--release"] : [])];

console.log(`[gitgui] cargo ${args.join(" ")}`);
console.log(`[gitgui] Electron server resource: ${destination}`);
if (dryRun) process.exit(0);
const result = spawnSync("cargo", args, { cwd: root, stdio: "inherit", shell: false });
if (result.error) fail(result.error.message);
if (result.status !== 0) process.exit(result.status ?? 1);
if (!existsSync(source)) fail(`Cargo did not produce ${source}`);
mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);
if (process.platform !== "win32") chmodSync(destination, 0o755);

function fail(message) {
  console.error(`[gitgui] ${message}`);
  process.exit(1);
}
