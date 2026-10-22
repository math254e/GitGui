import type { WorkerPoolManager } from "@pierre/diffs/worker";
import { DIFF_THEME_NAMES } from "../theme/diffTheme";

interface RendererResources {
  library: typeof import("@pierre/diffs");
  workers: WorkerPoolManager;
}

interface RendererLifecycle {
  disposed: boolean;
  workers?: WorkerPoolManager;
}

interface RendererEntry {
  users: number;
  lifecycle: RendererLifecycle;
  ready: Promise<RendererResources>;
}

let current: RendererEntry | undefined;

// The repository page warms this pool before a file is selected. Viewers share
// its one worker and two-entry AST caches, then release it when the page closes.
export function acquireDiffRenderer(): { ready: Promise<RendererResources>; release: () => void } {
  if (!current) {
    const lifecycle: RendererLifecycle = { disposed: false };
    const entry: RendererEntry = {
      users: 0,
      lifecycle,
      ready: initialize(lifecycle).catch((error) => {
        terminate(lifecycle);
        if (current === entry) current = undefined;
        throw error;
      }),
    };
    current = entry;
  }
  const entry = current;
  entry.users += 1;
  let released = false;
  return {
    ready: entry.ready,
    release() {
      if (released) return;
      released = true;
      if (--entry.users !== 0) return;
      entry.lifecycle.disposed = true;
      terminate(entry.lifecycle);
      if (current === entry) current = undefined;
    },
  };
}

function terminate(lifecycle: RendererLifecycle) {
  lifecycle.workers?.terminate();
  lifecycle.workers = undefined;
}

async function initialize(entry: RendererLifecycle): Promise<RendererResources> {
  const [library, { WorkerPoolManager }, { default: HighlightWorker }] = await Promise.all([
    import("@pierre/diffs"), import("@pierre/diffs/worker"),
    import("@pierre/diffs/worker/worker.js?worker"),
  ]);
  if (entry.disposed) throw new DOMException("Diff renderer released", "AbortError");
  const workers = new WorkerPoolManager({
    workerFactory: () => new HighlightWorker(),
    poolSize: 1,
    totalASTLRUCacheSize: 2,
  }, { theme: DIFF_THEME_NAMES, preferredHighlighter: "shiki-wasm", lineDiffType: "none", tokenizeMaxLineLength: 1000 });
  entry.workers = workers;
  // CodeView requires an initialized pool even for its initial plain text.
  // Never allow a failed pool to fall back to UI-thread highlighting.
  await workers.initialize();
  if (entry.disposed) throw new DOMException("Diff renderer released", "AbortError");
  return { library, workers };
}
