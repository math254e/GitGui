import { describe, expect, it, vi } from "vitest";
import { GitGuiClientError, GitGuiRpcError } from "@gitgui/client-runtime";
import type { ChangedFile, GitStashMutationResult, GitStashPushSelectedResult, StashInfo } from "@gitgui/contracts";
import { performStashOperation, selectedStashPaths, stashContextIsCurrent, stashReceiptNotice, validateStashReceipt, type StashReceiptRequest } from "./stash-operations";
import { captureStashActionContext, stashContextPaths } from "./stash-selection";
import { stashMenuItems, unsupportedStashActions } from "./stash-menu";
import { StashRead } from "./stash-read";

const stash: StashInfo = { selector: "stash@{0}", hash: "a".repeat(40), baseHash: "b".repeat(40), indexHash: null, branch: "main", message: "Saved work", timestamp: 1 };
const receipt: GitStashMutationResult = { repositoryId: "repo", target: { selector: stash.selector, expectedOid: stash.hash }, outcome: "success", stashState: "retained", restore: "succeeded", branch: null, error: null };
const diagnostic = { code: "stash_incomplete", message: "The stash was retained." };
const request = (action: "apply" | "pop" | "drop" | "branch"): StashReceiptRequest =>
  action === "branch" ? { action, repositoryId: "repo", target: receipt.target, name: "rescue" } : { action, repositoryId: "repo", target: receipt.target };
const selectedRequest = { action: "selected", repositoryId: "repo" } as const;

describe("stash review captures", () => {
  it("targets only the clicked staging section, and includes literal rename endpoints", () => {
    const selected = ["new\nname", ":(glob)*"];
    const files = [{ path: "new\nname", originalPath: "old name" }, { path: ":(glob)*", originalPath: null }, { path: "outside", originalPath: null }] as ChangedFile[];
    const paths = stashContextPaths(files[0].path, selected);
    const captured = selectedStashPaths(files.filter((file) => paths.includes(file.path)));
    expect(captured).toEqual(["old name", "new\nname", ":(glob)*"]);
    expect(selectedStashPaths(files.filter((file) => stashContextPaths("outside", selected).includes(file.path)))).toEqual(["outside"]);
    selected.length = 0; files[0].path = "changed";
    expect(captured).toEqual(["old name", "new\nname", ":(glob)*"]);
    expect(selectedStashPaths([])).toEqual([]);
  });

  it("refuses another environment/repository and stale or reindexed targets", () => {
    const captured = captureStashActionContext("env", "repo", stash);
    expect(stashContextIsCurrent(captured, "env", "repo", [stash])).toBe(true);
    for (const [env, repo, entries] of [["other", "repo", [stash]], ["env", "other", [stash]], ["env", "repo", []], ["env", "repo", [{ ...stash, selector: "stash@{1}" }]], ["env", "repo", [{ ...stash, hash: "c".repeat(40) }]]] as const) {
      expect(stashContextIsCurrent(captured, env, repo, entries)).toBe(false);
    }
  });

  it("requires separately advertised actions and presents ordinary menu items", () => {
    expect(stashMenuItems(unsupportedStashActions).every((item) => item.disabled)).toBe(true);
    const items = stashMenuItems({ ...unsupportedStashActions, pop: true });
    expect(items.filter((item) => !item.disabled).map((item) => item.id)).toEqual(["pop"]);
    expect(items.every((item) => !item.destructive)).toBe(true);
  });
});

describe("stash operation receipts", () => {
  it.each(["request_timeout", "transport", "client_error", "session_closed", "invalid_response"])("reports uncertain completion for actual adapter code %s in every error shape", async (code) => {
    for (const error of [new GitGuiClientError("No receipt", { code }), new GitGuiRpcError({ code, message: "No receipt" }), { type: "response", ok: false, error: { code, message: "No receipt" } }]) {
      const mutate = vi.fn(async () => { throw error; });
      const refresh = vi.fn(async () => {});
      const result = await performStashOperation(request("pop"), mutate, refresh);
      expect(result.receipt).toBeUndefined();
      expect(result.notice).toMatchObject({ tone: "warning", title: "Stash completion is unknown" });
      expect(result.notice.description).toContain("No receipt");
      expect(result.notice.description).toContain("inspect the stash and working changes before explicitly trying again");
      expect(mutate).toHaveBeenCalledTimes(1);
      expect(refresh).toHaveBeenCalledTimes(1);
    }
  });

  it.each(["unauthorized", "forbidden", "invalid_params", "stash_target_changed", "method_not_found", "server_busy"])("keeps known server rejection %s definite", async (code) => {
    for (const error of [new GitGuiClientError("Rejected", { code }), { type: "response", ok: false, error: { code, message: "Rejected" } }]) {
      const result = await performStashOperation(request("pop"), async () => { throw error; }, async () => {});
      expect(result.notice).toEqual({ tone: "error", title: "Stash operation failed", description: "Rejected" });
    }
  });

  it.each(["success", "conflicts", "partial", "branchCreatedRestoreFailed"] as const)("retains %s details across refresh failure without replay", async (outcome) => {
    const action = outcome === "branchCreatedRestoreFailed" ? "branch" : "pop";
    const mutation: GitStashMutationResult = { ...receipt, outcome, stashState: outcome === "success" ? "removed" : "retained",
      restore: outcome === "conflicts" ? "conflicts" : outcome === "branchCreatedRestoreFailed" ? "failed" : "succeeded",
      error: outcome === "success" ? null : diagnostic,
      branch: outcome === "branchCreatedRestoreFailed" ? { name: "rescue", switched: true } : null };
    const mutate = vi.fn(async () => mutation);
    const refresh = vi.fn(async () => { throw new Error("Refresh unavailable"); });
    const result = await performStashOperation(request(action), mutate, refresh);
    expect(result.receipt).toEqual(mutation);
    expect(result.notice).toEqual(stashReceiptNotice(action, mutation));
    expect(result.notice.description).toContain(outcome === "success" ? "saved stash was removed" : "saved stash is retained");
    expect(result.refreshError).toBeInstanceOf(Error);
    await refresh().catch(() => {});
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("distinguishes retained conflicts, restored-but-retained partial pop, and branch progress", () => {
    const conflict = stashReceiptNotice("pop", { ...receipt, outcome: "conflicts", restore: "conflicts" });
    expect(conflict.conflicts).toBe(true);
    expect(conflict.description).toContain("retained");
    expect(stashReceiptNotice("pop", { ...receipt, outcome: "partial" }).description).toContain("Saved changes restored");
    const branch = stashReceiptNotice("branch", { ...receipt, outcome: "partial", restore: "notAttempted", branch: { name: "rescue", switched: false }, error: diagnostic });
    expect(branch.description).toContain("not checked out");
    expect(branch.description).toContain("not attempted");
    expect(stashReceiptNotice("drop", { ...receipt, stashState: "removed", restore: "notAttempted" }).description).toBe("The saved stash was removed.");
  });

  it("reports saved partial cleanup and noChanges separately", () => {
    const selected: GitStashPushSelectedResult = { repositoryId: "repo", outcome: "partial", stash, error: diagnostic };
    const partial = stashReceiptNotice("selected", selected);
    expect(partial.title).toContain("cleanup incomplete");
    expect(partial.description).toContain("retained");
    expect(stashReceiptNotice("selected", { ...selected, outcome: "noChanges", stash: null }).title).toBe("No changes to stash");
  });

  it("refreshes failures and unknown transport completion once, without autoreplay", async () => {
    const refresh = vi.fn(async () => {});
    const mutate = vi.fn(async () => { throw { code: "disconnected", message: "Connection lost" }; });
    const result = await performStashOperation(request("pop"), mutate, refresh);
    expect(result.notice.title).toBe("Stash completion is unknown");
    expect(result.notice.description).toContain("not replayed");
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    const failed = await performStashOperation(request("apply"), async () => { throw { code: "stale_stash", message: "Stash changed" }; }, refresh);
    expect(failed.notice.title).toBe("Stash operation failed");
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

describe("untrusted successful stash receipts", () => {
  it.each([
    ["apply", {}, "success"],
    ["pop", { stashState: "removed" }, "success"],
    ["drop", { stashState: "removed", restore: "notAttempted" }, "success"],
    ["apply", { outcome: "conflicts", restore: "conflicts", error: diagnostic }, "warning"],
    ["pop", { outcome: "conflicts", restore: "conflicts", error: diagnostic }, "warning"],
    ["apply", { outcome: "partial", restore: "failed", error: diagnostic }, "warning"],
    ["pop", { outcome: "partial", restore: "failed", error: diagnostic }, "warning"],
    ["pop", { outcome: "partial", error: diagnostic }, "warning"],
    ["drop", { outcome: "partial", restore: "notAttempted", error: diagnostic }, "warning"],
    ["branch", { stashState: "removed", branch: { name: "rescue", switched: true } }, "success"],
    ["branch", { outcome: "partial", restore: "notAttempted", error: diagnostic }, "warning"],
    ["branch", { outcome: "partial", restore: "notAttempted", branch: { name: "rescue", switched: false }, error: diagnostic }, "warning"],
    ["branch", { outcome: "branchCreatedRestoreFailed", restore: "failed", branch: { name: "rescue", switched: true }, error: diagnostic }, "warning"],
    ["branch", { outcome: "branchCreatedRestoreFailed", restore: "conflicts", branch: { name: "rescue", switched: true }, error: diagnostic }, "warning"],
    ["branch", { outcome: "partial", branch: { name: "rescue", switched: true }, error: diagnostic }, "warning"],
  ] satisfies Array<["apply" | "pop" | "drop" | "branch", Partial<GitStashMutationResult>, string]>)
  ("accepts documented %s progress: %j", async (action, changes, tone) => {
    const value = { ...receipt, ...changes, futureField: "compatible" };
    const effect = vi.fn();
    const result = await performStashOperation(request(action), async () => value, async () => {
      expect(effect).toHaveBeenCalledExactlyOnceWith(value);
    }, effect);
    expect(result.receipt).toEqual(value);
    expect(result.notice.tone).toBe(tone);
    expect(result.notice.title).not.toContain("unknown");
  });

  it.each([
    ["success", stash, null, "success"], ["noChanges", null, null, "info"],
    ["partial", stash, diagnostic, "warning"], ["partial", null, diagnostic, "warning"],
  ])("accepts selected %s with saved entry %j", async (outcome, saved, error, tone) => {
    const value = { repositoryId: "repo", outcome, stash: saved, error, futureField: true, stashState: "an unrelated future field" };
    const result = await performStashOperation(selectedRequest, async () => value, async () => {});
    expect(result.receipt).toEqual(value);
    expect(result.notice.tone).toBe(tone);
  });

  it.each([
    null, {}, [], "success", { ...receipt, repositoryId: "other" },
    { ...receipt, outcome: "futureOutcome" }, { ...receipt, stashState: "gone" }, { ...receipt, restore: "done" },
    { ...receipt, target: { ...receipt.target, selector: "stash@{1}" } },
    { ...receipt, target: { ...receipt.target, expectedOid: "c".repeat(40) } },
    { ...receipt, target: { ...receipt.target, expectedOid: "a".repeat(64) } },
    { ...receipt, target: { ...receipt.target, expectedOid: "A".repeat(40) } },
    { ...receipt, target: { ...receipt.target, expectedOid: "aaaa" } },
    { ...receipt, branch: undefined }, { ...receipt, branch: { name: "rescue", switched: true } },
    { ...receipt, error: undefined }, { ...receipt, error: { code: 1, message: "Unsafe" } },
    { ...receipt, error: { code: "partial", message: { text: "Unsafe" } } },
    { ...receipt, outcome: "conflicts", restore: "succeeded", error: diagnostic },
    { ...receipt, outcome: "partial", restore: "succeeded", error: null },
    { ...receipt, outcome: "partial", restore: "failed", stashState: "removed", error: diagnostic },
    { ...receipt, outcome: "branchCreatedRestoreFailed", restore: "failed", error: diagnostic },
    { repositoryId: "repo", outcome: "success", stash, error: null },
  ])("rejects malformed or mismatched mutation payload %j before side effects", async (value) => {
    const effect = vi.fn(); const refresh = vi.fn(async () => {});
    const result = await performStashOperation(request("pop"), async () => value, refresh, effect);
    expect(result.receipt).toBeUndefined(); expect(effect).not.toHaveBeenCalled();
    expect(result.notice).toMatchObject({ tone: "warning", title: "Stash completion is unknown" });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it.each(["repositoryId", "target", "outcome", "stashState", "restore", "branch", "error"])("requires mutation field %s", (field) => {
    const value: Record<string, unknown> = { ...receipt }; delete value[field];
    expect(() => validateStashReceipt(request("apply"), value)).toThrow();
  });

  it.each([
    { ...stash, hash: "short" }, { ...stash, baseHash: null }, { ...stash, baseHash: "b".repeat(64) },
    { ...stash, indexHash: "short" }, { ...stash, selector: "stash@{01}" }, { ...stash, branch: {} },
    { ...stash, message: [] }, { ...stash, timestamp: "1" }, { ...stash, timestamp: NaN }, { ...stash, timestamp: 1.5 },
  ])("rejects unusable saved-stash metadata %j", (saved) => {
    expect(() => validateStashReceipt(selectedRequest, { repositoryId: "repo", outcome: "success", stash: saved, error: null })).toThrow();
  });

  it.each(["hash", "selector", "baseHash", "indexHash", "branch", "message", "timestamp"])("requires saved-stash metadata %s", (field) => {
    const saved: Record<string, unknown> = { ...stash }; delete saved[field];
    expect(() => validateStashReceipt(selectedRequest, { repositoryId: "repo", outcome: "success", stash: saved, error: null })).toThrow();
  });

  it("accepts full SHA-256 saved metadata, nullable fields, and optional diagnostic context", () => {
    const saved = { ...stash, hash: "a".repeat(64), baseHash: "b".repeat(64), indexHash: "c".repeat(64), branch: null, message: "", timestamp: -1 };
    const value = { repositoryId: "repo", outcome: "partial", stash: saved, error: { ...diagnostic, details: null } };
    expect(validateStashReceipt(selectedRequest, value)).toBe(value);
    const sha256 = { ...receipt, target: { ...receipt.target, expectedOid: saved.hash } };
    expect(validateStashReceipt({ action: "apply", repositoryId: "repo", target: sha256.target }, sha256)).toBe(sha256);
  });
});

describe("stash inspection lifetime", () => {
  it("rejects a late read after stash/repository/environment replacement, even when cancellation is ignored", async () => {
    const scope = new StashRead();
    const results: string[] = [];
    const old = scope.begin();
    const late = Promise.resolve().then(() => { if (old.current()) results.push("old environment"); });
    const current = scope.begin();
    expect(old.signal.aborted).toBe(true);
    await late;
    if (current.current()) results.push("new environment");
    expect(results).toEqual(["new environment"]);
    scope.cancel();
    expect(current.current()).toBe(false);
  });
});
