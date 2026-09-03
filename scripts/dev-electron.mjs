import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const electron = join(root, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
const shell = process.platform === "win32";
const electronEnvironment = { ...process.env };
delete electronEnvironment.ELECTRON_RUN_AS_NODE;
const children = new Set();
let closing = false;

runChecked("cargo", ["build", "-p", "gitgui-server"]);
runChecked(npm, ["run", "desktop:build"]);
runChecked(npm, ["exec", "--workspace", "@gitgui/web", "--", "svelte-kit", "sync"]);
if (!existsSync(electron)) throw new Error("Electron is not installed; run npm install");

const vite = start(npm, ["run", "ui:dev"]);
await waitForUrl("http://127.0.0.1:1420", vite);
const desktop = start(electron, [join(root, "apps", "desktop")], electronEnvironment);
desktop.once("exit", (code) => shutdown(code ?? 0));

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

function runChecked(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function start(command, args, env = process.env) {
  const child = spawn(command, args, { cwd: root, stdio: "inherit", shell, windowsHide: true, env });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

async function waitForUrl(url, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Vite exited before becoming ready");
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  throw new Error("Vite did not become ready within 30 seconds");
}

function shutdown(code) {
  if (closing) return;
  closing = true;
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill();
  }
  setTimeout(() => process.exit(code), 250).unref();
}
