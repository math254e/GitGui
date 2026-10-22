import { describe, expect, it, vi } from "vitest";
import { parseDiffInWorker } from "./parser";
import type { DiffParseRequest } from "./parse";

const request: DiffParseRequest = { originalPath: null, modifiedPath: "code.ts", originalContent: "", modifiedContent: "code", cacheKey: "selection" };

function worker() {
  return { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null, onerror: null, onmessageerror: null } as unknown as Worker;
}

describe("diff parser lifecycle", () => {
  it("terminates running work on selection changes and does not start already cancelled work", async () => {
    const instance = worker();
    const create = vi.fn(() => instance);
    const controller = new AbortController();
    const result = parseDiffInWorker(request, controller.signal, create);
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(instance.terminate).toHaveBeenCalledOnce();
    expect(instance.onmessage).toBeNull();
    await expect(parseDiffInWorker(request, controller.signal, create)).rejects.toMatchObject({ name: "AbortError" });
    expect(create).toHaveBeenCalledOnce();
  });

  it("releases workers on success and reports parser failures without a synchronous fallback", async () => {
    for (const response of [{ metadata: {}, durationMs: 1 }, { error: "Invalid patch" }]) {
      const instance = worker();
      const result = parseDiffInWorker(request, new AbortController().signal, () => instance);
      instance.onmessage!({ data: response } as MessageEvent);
      if ("error" in response) await expect(result).rejects.toThrow("Invalid patch");
      else await expect(result).resolves.toEqual(response);
      expect(instance.terminate).toHaveBeenCalledOnce();
    }
  });

  it("releases workers when startup or message transfer fails", async () => {
    for (const failure of ["error", "messageerror", "postMessage"] as const) {
      const instance = worker();
      if (failure === "postMessage") vi.mocked(instance.postMessage).mockImplementation(() => { throw new Error("Cannot clone"); });
      const result = parseDiffInWorker(request, new AbortController().signal, () => instance);
      if (failure === "error") instance.onerror!({ preventDefault() {}, message: "Worker failed" } as ErrorEvent);
      if (failure === "messageerror") instance.onmessageerror!({} as MessageEvent);
      await expect(result).rejects.toThrow();
      expect(instance.terminate).toHaveBeenCalledOnce();
    }
  });
});
