import type { DiffParseRequest, DiffParseResponse } from "./parse";

export function parseDiffInWorker(
  request: DiffParseRequest,
  signal: AbortSignal,
  createWorker: () => Worker = () => new Worker(new URL("./parse.worker.ts", import.meta.url), { type: "module" }),
): Promise<Extract<DiffParseResponse, { metadata: unknown }>> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Diff parsing cancelled", "AbortError"));
      return;
    }
    const worker = createWorker();
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    };
    const abort = () => {
      cleanup();
      reject(new DOMException("Diff parsing cancelled", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event: MessageEvent<DiffParseResponse>) => {
      cleanup();
      if ("error" in event.data) reject(new Error(event.data.error));
      else resolve(event.data);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      cleanup();
      reject(new Error(event.message || "Could not start the diff parser. Retry to load this file."));
    };
    worker.onmessageerror = () => {
      cleanup();
      reject(new Error("Could not read the parsed diff. Retry to load this file."));
    };
    try {
      worker.postMessage(request);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
