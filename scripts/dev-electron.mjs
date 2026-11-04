import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { assertDevBackendStopped } from "./dev-preflight.mjs";
import { runDesktopSession } from "./dev-session.mjs";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(import.meta.dirname, "..");
const npmCli = process.env.npm_execpath;
if (!npmCli || !existsSync(npmCli)) throw new Error("Start desktop development with npm run dev.");
const require = createRequire(import.meta.url);
const electron = require("electron");
const viteCli = join(dirname(require.resolve("vite/package.json")), "bin", "vite.js");
const electronEnvironment = { ...process.env };
delete electronEnvironment.ELECTRON_RUN_AS_NODE;
electronEnvironment.GITGUI_DESKTOP_DEV_LAUNCHER = "1";

try {
  assertDevBackendStopped(root);
} catch (error) {
  console.error(`[gitgui] ${error.message}`);
  process.exit(1);
}
runChecked("cargo", ["build", "-p", "gitgui-server"]);
runChecked(process.execPath, [npmCli, "run", "desktop:build"]);
runChecked(process.execPath, [npmCli, "exec", "--workspace", "@gitgui/web", "--", "svelte-kit", "sync"]);
if (!existsSync(electron)) throw new Error("Electron is not installed; run npm install");

// Own Vite itself: terminating an npm/cmd wrapper on Windows leaves its
// descendants and development port running.
process.exitCode = await runDesktopSession({
  startVite: () => start(process.execPath, [viteCli, "dev"], { cwd: join(root, "apps", "web") }),
  // Match Electron's CLI: windowsHide would hide its first native window.
  startDesktop: () => start(electron, [join(root, "apps", "desktop")], {
    env: electronEnvironment, windowsHide: false, stdio: ["inherit", "inherit", "inherit", "ipc"],
  }),
  waitForReady: (child, signal) => waitForUrl("http://127.0.0.1:1420", child, signal),
});

function runChecked(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: false, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function start(command, args, { env = process.env, cwd = root, windowsHide = true, stdio = "inherit" } = {}) {
  return spawn(command, args, { cwd, stdio, shell: false, windowsHide, env });
}

async function waitForUrl(url, child, signal) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (child.exitCode !== null) throw new Error("Vite exited before becoming ready");
    try {
      const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(1_000)]) });
      if (response.ok) return;
    } catch {}
    await delay(200, undefined, { signal });
  }
  throw new Error("Vite did not become ready within 30 seconds");
}
