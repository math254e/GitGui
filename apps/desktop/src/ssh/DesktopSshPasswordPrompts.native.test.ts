// Tests the native adapter with Electron event fixtures; this does not qualify
// actual OS window presentation or OpenSSH askpass execution.
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import type { BrowserWindow } from "electron";

const native = vi.hoisted(() => ({ windows: [] as any[], ipc: undefined as any, failPresentation: false }));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  native.ipc = new EventEmitter();
  return { ipcMain: native.ipc, dialog: {}, BrowserWindow: class extends EventEmitter {
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), { mainFrame: {}, setWindowOpenHandler: vi.fn(() => { if (native.failPresentation) throw new Error("fixture presentation failed"); }) });
    constructor(readonly options: unknown) { super(); native.windows.push(this); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit("closed"); }
    loadURL = vi.fn(async () => undefined);
    show = vi.fn(); focus = vi.fn();
  } };
});
import { makePasswordPrompts, nativePasswordPresenter } from "./DesktopSshPasswordPrompts.js";

const scopes: Scope.Closeable[] = [];
afterEach(async () => {
  for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void));
  native.ipc.removeAllListeners(); native.windows.length = 0; native.failPresentation = false;
});
async function fixture() {
  const parent = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  const scope = Scope.makeUnsafe("sequential"); scopes.push(scope);
  const prompts = await Effect.runPromise(makePasswordPrompts(nativePasswordPresenter(() => parent as unknown as BrowserWindow)).pipe(Effect.provideService(Scope.Scope, scope)));
  return { parent, prompts };
}

describe("SSH password modal sender boundary", () => {
  it("accepts only the exact prompt window, main frame and request ID and removes listeners", async () => {
    const f = await fixture(); const result = Effect.runPromise(f.prompts.request("Password <untrusted>"));
    await vi.waitFor(() => expect(native.windows).toHaveLength(1));
    const window = native.windows[0];
    const id = window.options.webPreferences.additionalArguments[0].slice("--gitgui-prompt-id=".length);
    expect(window.options.webPreferences).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true });
    expect(decodeURIComponent(window.loadURL.mock.calls[0][0])).toContain("Password &lt;untrusted&gt;");
    native.ipc.emit("desktop:secret-prompt:response", { sender: {}, senderFrame: window.webContents.mainFrame }, id, "foreign sender");
    native.ipc.emit("desktop:secret-prompt:response", { sender: window.webContents, senderFrame: {} }, id, "foreign frame");
    native.ipc.emit("desktop:secret-prompt:response", { sender: window.webContents, senderFrame: window.webContents.mainFrame }, "wrong-id", "wrong prompt");
    expect(window.destroyed).toBe(false);
    native.ipc.emit("desktop:secret-prompt:response", { sender: window.webContents, senderFrame: window.webContents.mainFrame }, id, "accepted secret");
    expect(await result).toBe("accepted secret");
    expect(window.destroyed).toBe(true); expect(native.ipc.listenerCount("desktop:secret-prompt:response")).toBe(0);
    expect(f.parent.listenerCount("closed")).toBe(0);
  });
  it("cancels and destroys the modal when its parent closes", async () => {
    const f = await fixture(); const result = expect(Effect.runPromise(f.prompts.request("Password"))).rejects.toMatchObject({ category: "authentication" });
    await vi.waitFor(() => expect(native.windows).toHaveLength(1)); f.parent.emit("closed");
    await result; expect(native.windows[0].destroyed).toBe(true);
    expect(native.ipc.listenerCount("desktop:secret-prompt:response")).toBe(0);
  });
  it("destroys a partially created presentation when Electron throws", async () => {
    const f = await fixture(); native.failPresentation = true;
    await expect(Effect.runPromise(f.prompts.request("Password"))).rejects.toMatchObject({ category: "authentication" });
    expect(native.windows[0].destroyed).toBe(true);
    expect(f.parent.listenerCount("closed")).toBe(0); expect(native.ipc.listenerCount("desktop:secret-prompt:response")).toBe(0);
  });
});
