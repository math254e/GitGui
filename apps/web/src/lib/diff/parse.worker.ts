import { parseFileDiff } from "./parse";
import type { DiffParseRequest, DiffParseResponse } from "./parse";

self.onmessage = (event: MessageEvent<DiffParseRequest>) => {
  const started = performance.now();
  let response: DiffParseResponse;
  try {
    response = { metadata: parseFileDiff(event.data), durationMs: performance.now() - started };
  } catch (error) {
    response = { error: error instanceof Error ? error.message : String(error) };
  }
  self.postMessage(response);
};
