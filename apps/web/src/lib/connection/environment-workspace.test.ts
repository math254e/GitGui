import { describe, expect, it, vi } from "vitest";
import type { RepositorySnapshot, RepositorySummary, WelcomeMessage } from "@gitgui/contracts";
import type { RpcSession } from "@gitgui/client-runtime/rpc/session";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { EnvironmentWorkspaceData, type EnvironmentWorkspaceOptions } from "./environment-workspace";
import { InMemoryWorkspaceMetadataAdapter } from "../client-runtime/metadata";

describe("environment workspace activation", () => {
  it("lets replacement target hydration finish readiness after cancelling initial hydration", async () => {
    const repository: RepositorySummary = { id: "repo", name: "Repo", path: "/repo", root: "/repo", isWorktree: false };
    const snapshot: RepositorySnapshot = {
      info: { path: "/repo", root: "/repo" }, status: { currentBranch: "main", headOid: null, ahead: 0, behind: 0, changedFiles: [] },
      commits: [], refs: [], stashes: [], worktrees: [], graph: { commits: [], edges: [], headLane: null, width: 1 },
    };
    const welcome: WelcomeMessage = { type: "welcome", environment_id: "a", server_id: "server", protocol_version: 2, capabilities: [] };
    let firstList = true, cancelled = false;
    let release!: () => void;
    const request = vi.fn(async (method: string, _input: unknown, signal: AbortSignal) => {
      if (method === "repositories.list") {
        if (firstList) {
          firstList = false;
          await new Promise<void>((resolve, reject) => {
            release = resolve;
            signal.addEventListener("abort", () => { cancelled = true; reject(new Error("cancelled initial read")); }, { once: true });
          });
        }
        return { repositories: [repository] };
      }
      return { repositories: [{ repositoryId: "repo", repository, snapshot }] };
    });
    const data = new EnvironmentWorkspaceData({
      environmentId: "a", metadataAdapter: new InMemoryWorkspaceMetadataAdapter(), tabOwnership: "external",
      request: request as EnvironmentWorkspaceOptions["request"], welcome: async () => welcome, onChange: () => {},
    });
    try {
      await data.initialized;
      data.setSession({ client: { events: Stream.never }, sequenceGaps: Stream.never, welcome: Effect.succeed(welcome) } as unknown as RpcSession);
      await vi.waitFor(() => expect(release).toBeDefined());
      expect(data.state.ready).toBe(false);
      await data.setRepositoryTargets(["repo"], "repo");
      expect(cancelled).toBe(true);
      expect(data.state).toMatchObject({ ready: true, loading: false, error: "" });
      expect(data.workspace.state.repositories.repo.snapshot).toEqual(snapshot);
      release(); await Promise.resolve();
      expect(data.state).toMatchObject({ ready: true, loading: false, error: "" });
    } finally { data.dispose(); }
  });
});
