import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { assertDevBackendStopped } from "./dev-preflight.mjs";

test("does not query Windows processes on Linux", () => {
  assertDevBackendStopped("/fixture", { platform: "linux", run() { throw new Error("must not run"); } });
});

test("checks the actual Cargo target and gives a useful error before build", () => {
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: command === "cargo" ? JSON.stringify({ target_directory: "/isolated-target" }) : "12345" };
  };
  assert.throws(() => assertDevBackendStopped("/fixture", { platform: "win32", run, env: {} }), /development server is still running.*12345.*launcher terminal/);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ["metadata", "--no-deps", "--format-version", "1", "--locked"]);
  assert.equal(calls[1].options.env.GITGUI_DEV_BACKEND_CHECK, join("/isolated-target", "debug", "gitgui-server.exe"));
  assert.match(calls[1].args.at(-1), /ExecutablePath.*Equals/);
  assert.doesNotMatch(calls[1].args.at(-1), /Stop-Process|CommandLine/);
});

test("permits a stopped checkout without killing or building anything", () => {
  const commands = [];
  assertDevBackendStopped("/fixture", { platform: "win32", run(command) {
    commands.push(command);
    return { status: 0, stdout: command === "cargo" ? JSON.stringify({ target_directory: "/target" }) : "" };
  } });
  assert.deepEqual(commands, ["cargo", "powershell.exe"]);
});

test("fails before build if the process lookup fails", () => {
  assert.throws(() => assertDevBackendStopped("/fixture", { platform: "win32", run(command) {
    return command === "cargo" ? { status: 0, stdout: JSON.stringify({ target_directory: "/target" }) } : { status: 1 };
  } }), /Could not check for an existing desktop session/);
});
