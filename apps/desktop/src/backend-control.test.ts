import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { BackendControl, waitForBackendExit } from "./backend-control.js";

function childFixture() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(),
    stderr: new PassThrough(), exitCode: null as number | null, signalCode: null });
  return child as unknown as ChildProcessWithoutNullStreams;
}

describe("inherited local server control", () => {
  it("correlates split replies, ignores unrelated stdout, and bounds error text", async () => {
    const child = childFixture(); const control = new BackendControl(child);
    const writes: string[] = []; child.stdin.on("data", (chunk) => writes.push(String(chunk)));
    const ready = control.request("prepare-update");
    const id = JSON.parse(writes[0]).id;
    child.stdout.emit("data", Buffer.from(`ordinary diagnostic\nGITGUI_SERVER_CONTROL={"id":"other","ok":true}\nGITGUI_SERVER_CON`));
    child.stdout.emit("data", Buffer.from(`TROL={"id":"${id}","ok":true}\n`));
    await ready;
    const resume = control.request("resume");
    const second = JSON.parse(writes[1]).id;
    child.stdout.emit("data", Buffer.from(`GITGUI_SERVER_CONTROL={"id":"${second}","ok":false,"message":"private"}\n`));
    await expect(resume).rejects.toThrow("could not prepare");
    control.dispose();
  });

  it("rejects pending control on owner exit without leaking request timers", async () => {
    const child = childFixture(); const control = new BackendControl(child);
    const pending = control.request("prepare-update");
    child.emit("exit", 1);
    await expect(pending).rejects.toThrow("channel closed");
    expect(child.stdout.listenerCount("data")).toBe(0);
    await expect(control.request("resume")).rejects.toThrow("unavailable");
  });

  it("rejects new requests for a child already terminated by a signal", async () => {
    const child = childFixture(); const control = new BackendControl(child);
    Object.assign(child, { signalCode: "SIGTERM" });
    await expect(control.request("resume")).rejects.toThrow("unavailable");
    await expect(waitForBackendExit(child, 100)).resolves.toBeUndefined();
    control.dispose();
  });

  it("times out without terminating the child and waits for an actual exit", async () => {
    vi.useFakeTimers();
    try {
      const child = childFixture(); const control = new BackendControl(child);
      const pending = control.request("prepare-update", 100);
      const rejected = expect(pending).rejects.toThrow("did not finish");
      await vi.advanceTimersByTimeAsync(100); await rejected;
      const exited = waitForBackendExit(child, 100);
      child.emit("exit", 0); await exited;
      control.dispose();
    } finally { vi.useRealTimers(); }
  });
});
