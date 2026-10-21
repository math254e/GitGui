import { getContext, setContext } from "svelte";
import type { WebApplicationRuntime } from "$lib/connection/runtime";
import { WorkspaceStore } from "./workspace-store.svelte";

const WORKSPACE_STORE = Symbol("gitgui.workspace-store");

/**
 * Mount the workspace store.
 *
 * The store is created once, at the application root, so the connection
 * runtime and the workspace state share one lifetime.
 */
export function provideWorkspaceStore(runtime: WebApplicationRuntime): WorkspaceStore {
  const store = new WorkspaceStore(runtime);
  setContext(WORKSPACE_STORE, store);
  return store;
}

export function useWorkspaceStore(): WorkspaceStore {
  const store = getContext<WorkspaceStore | undefined>(WORKSPACE_STORE);
  if (!store) {
    throw new Error("The GitGui workspace store was not mounted at the application root");
  }
  return store;
}
