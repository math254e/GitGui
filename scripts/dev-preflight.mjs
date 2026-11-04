import { spawnSync } from "node:child_process";
import { join } from "node:path";

// T3 checks its dev prerequisites before launch. GitGui additionally checks the
// exact Rust target: Windows cannot replace an executable a desktop still owns.
const processQuery = `
$ErrorActionPreference = 'Stop'
$expected = $env:GITGUI_DEV_BACKEND_CHECK
@((Get-CimInstance Win32_Process -Filter "Name = 'gitgui-server.exe'") |
  Where-Object { $_.ExecutablePath -and [string]::Equals($_.ExecutablePath, $expected, [System.StringComparison]::OrdinalIgnoreCase) } |
  ForEach-Object { [int]$_.ProcessId }) | ConvertTo-Json -Compress
`;

export function assertDevBackendStopped(root, { platform = process.platform, run = spawnSync, env = process.env } = {}) {
  if (platform !== "win32") return;
  const metadata = run("cargo", ["metadata", "--no-deps", "--format-version", "1", "--locked"], {
    cwd: root, encoding: "utf8", windowsHide: true,
  });
  if (metadata.error || metadata.status !== 0) throw new Error("Could not locate the Cargo target before desktop startup. Check that Cargo is available.");
  const target = JSON.parse(metadata.stdout).target_directory;
  if (typeof target !== "string" || !target) throw new Error("Cargo did not report its target directory.");
  const executable = join(target, "debug", "gitgui-server.exe").replace(/^\\\\\?\\([A-Za-z]:)/, "$1");
  const result = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", processQuery], {
    cwd: root, encoding: "utf8", windowsHide: true,
    env: { ...env, GITGUI_DEV_BACKEND_CHECK: executable },
  });
  if (result.error || result.status !== 0) throw new Error("Could not check for an existing desktop session. Close GitGui before rebuilding.");
  const parsed = result.stdout.trim() ? JSON.parse(result.stdout) : [];
  const pids = Array.isArray(parsed) ? parsed : [parsed];
  if (pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) throw new Error("Invalid desktop session process result.");
  if (pids.length) {
    throw new Error(`GitGui's development server is still running from this checkout (PID ${pids.join(", ")}). Close its desktop window or stop its launcher terminal before rebuilding, then run npm run dev:desktop again.`);
  }
}
