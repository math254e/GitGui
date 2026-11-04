import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { registerDevelopmentLauncher } from "./dev-launcher.js";

function parent() { return Object.assign(new EventEmitter(), { send: vi.fn() }); }

describe("private development launcher shutdown", () => {
  it("accepts only the exact quit message and releases listeners", () => {
    const channel = parent(); const quit = vi.fn();
    const release = registerDevelopmentLauncher({ isPackaged: false }, quit, channel as any, true);
    channel.emit("message", { command: "quit" }); channel.emit("message", "other");
    expect(quit).not.toHaveBeenCalled();
    channel.emit("message", "gitgui:dev:quit"); expect(quit).toHaveBeenCalledOnce();
    release(); channel.emit("message", "gitgui:dev:quit"); channel.emit("disconnect");
    expect(quit).toHaveBeenCalledOnce();
  });
  it("requests normal quit if the owning launcher disappears", () => {
    const channel = parent(); const quit = vi.fn();
    const release = registerDevelopmentLauncher({ isPackaged: false }, quit, channel as any, true);
    channel.emit("disconnect"); expect(quit).toHaveBeenCalledOnce(); release();
  });
  it("does not expose a shutdown listener in packaged or unmanaged launches", () => {
    for (const [isPackaged, enabled] of [[true, true], [false, false]]) {
      const channel = parent(); const quit = vi.fn();
      registerDevelopmentLauncher({ isPackaged }, quit, channel as any, enabled);
      channel.emit("message", "gitgui:dev:quit"); channel.emit("disconnect");
      expect(quit).not.toHaveBeenCalled(); expect(channel.eventNames()).toEqual([]);
    }
  });
});
