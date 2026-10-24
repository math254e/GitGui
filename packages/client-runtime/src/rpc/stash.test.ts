import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { vi } from "vitest";
import { GitGuiClient } from "./promise.ts";

const target = { selector: "stash@{0}", expectedOid: "a".repeat(40) };

function setup() {
  const call = vi.fn(() => Effect.succeed(null as never));
  const client = new GitGuiClient({
    client: { call, events: Stream.empty },
    welcome: {
      type: "welcome", server_id: "environment", environment_id: "environment",
      protocol_version: 2, capabilities: [],
    },
  });
  return { call, client };
}

describe("stash RPC boundary", () => {
  it("rejects empty explicit selection without sending stash-all", () => {
    const { call, client } = setup();
    try {
      expect(() => client.stashPushSelected({ repositoryId: "repo", source: "staged", paths: [] })).toThrow(TypeError);
      expect(call).not.toHaveBeenCalled();
    } finally { client.dispose(); }
  });

  it("preserves literal paths and selected side while retaining legacy defaults", async () => {
    const { call, client } = setup();
    try {
      const paths = [" leading space ", ":(glob)*", "line\nbreak"];
      await client.stashPushSelected({ repositoryId: "repo", source: "unstaged", paths });
      expect(call).toHaveBeenLastCalledWith("git.stash.push_selected", { repositoryId: "repo", source: "unstaged", paths });
      await client.stashPush({ repositoryId: "repo", includeUntracked: true });
      expect(call).toHaveBeenLastCalledWith("git.stash.push", { repositoryId: "repo", includeUntracked: true });
      await client.stashPop("repo");
      expect(call).toHaveBeenLastCalledWith("git.stash.pop", { repositoryId: "repo" });
    } finally { client.dispose(); }
  });

  it("requires an explicit full reviewed target and sends targeted pop once", async () => {
    const { call, client } = setup();
    try {
      expect(() => client.stashPopTarget({ repositoryId: "repo", target: { ...target, expectedOid: "abc123" } })).toThrow(TypeError);
      expect(() => client.stashDrop({ repositoryId: "repo", target: { ...target, selector: "refs/stash" } })).toThrow(TypeError);
      expect(call).not.toHaveBeenCalled();
      await client.stashPopTarget({ repositoryId: "repo", target });
      expect(call).toHaveBeenCalledExactlyOnceWith("git.stash.pop_target", { repositoryId: "repo", target });
    } finally { client.dispose(); }
  });
});
