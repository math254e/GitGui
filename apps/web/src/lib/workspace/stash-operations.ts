import type { ChangedFile, GitStashMutationResult, GitStashPushSelectedResult, GitStashSelectionSource, GitStashTarget, ProtocolError, StashInfo } from "@gitgui/contracts";
import type { StashActionContext } from "./types";
import { summarizeGitError } from "./errors";

export type StashAction = "apply" | "pop" | "drop" | "branch";
export const stashMethods = {
  selected: "git.stash.push_selected", apply: "git.stash.apply", pop: "git.stash.pop_target",
  drop: "git.stash.drop", branch: "git.stash.branch", files: "git.stash.files", diff: "git.stash.file_diff",
} as const;

export type StashDialog = {
  context: StashActionContext;
  stash: StashInfo;
  action: Exclude<StashAction, "apply">;
  destination: string;
  destinationHead: string | null;
} | {
  context: { readonly environmentId: string; readonly repositoryId: string };
  action: "selected";
  source: GitStashSelectionSource;
  paths: string[];
};

/** Rename endpoints are literal paths too; do not turn them into pathspecs. */
export function selectedStashPaths(files: readonly ChangedFile[]): string[] {
  return [...new Set(files.flatMap((file) => file.originalPath ? [file.originalPath, file.path] : [file.path]))];
}

export function stashContextIsCurrent(
  context: { environmentId: string; repositoryId: string; target?: StashActionContext["target"] },
  environmentId: string | null | undefined,
  repositoryId: string | null,
  stashes: readonly StashInfo[],
): boolean {
  return context.environmentId === environmentId && context.repositoryId === repositoryId &&
    (!context.target || stashes.some((stash) => stash.selector === context.target!.selector && stash.hash === context.target!.expectedOid));
}

export type StashReceipt = GitStashMutationResult | GitStashPushSelectedResult;
export type StashReceiptRequest = { repositoryId: string } & (
  { action: "selected" } |
  { action: Exclude<StashAction, "branch">; target: GitStashTarget } |
  { action: "branch"; target: GitStashTarget; name: string }
);
export type StashNotice = { tone: "success" | "warning" | "error" | "info"; title: string; description: string; conflicts?: boolean };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Match the submitted target contract: full, lowercase SHA-1 or SHA-256 IDs.
function fullOid(value: unknown): value is string {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

function stashSelector(value: unknown): value is string {
  return typeof value === "string" && /^stash@\{(?:0|[1-9][0-9]*)\}$/.test(value);
}

function savedStash(value: unknown): value is StashInfo {
  return record(value) && fullOid(value.hash) && stashSelector(value.selector) &&
    fullOid(value.baseHash) && value.baseHash.length === value.hash.length &&
    (value.indexHash === null || (fullOid(value.indexHash) && value.indexHash.length === value.hash.length)) &&
    (value.branch === null || typeof value.branch === "string") &&
    typeof value.message === "string" && typeof value.timestamp === "number" && Number.isSafeInteger(value.timestamp);
}

function receiptError(value: unknown): value is ProtocolError | null {
  // Details are optional JSON context; presentation only reads typed stderr/status.
  return value === null || (record(value) && typeof value.code === "string" && typeof value.message === "string");
}

function mutationMeaning(request: Exclude<StashReceiptRequest, { action: "selected" }>, receipt: GitStashMutationResult): boolean {
  const { outcome, stashState, restore, branch, error } = receipt;
  if (request.action !== "branch" && branch !== null) return false;
  if (outcome === "success") {
    if (error !== null) return false;
    if (request.action === "apply") return stashState === "retained" && restore === "succeeded";
    if (request.action === "drop") return stashState === "removed" && restore === "notAttempted";
    return stashState === "removed" && restore === "succeeded" && (request.action !== "branch" || branch?.switched === true);
  }
  // No incomplete operation authorizes removal. A diagnostic is essential to
  // distinguish partial progress from a successful operation or a refresh error.
  if (stashState !== "retained" || error === null) return false;
  if (request.action === "branch") {
    if (!branch || !branch.switched) return outcome === "partial" && restore === "notAttempted";
    return (outcome === "branchCreatedRestoreFailed" && (restore === "failed" || restore === "conflicts")) ||
      (outcome === "partial" && restore === "succeeded");
  }
  if (request.action === "drop") return outcome === "partial" && restore === "notAttempted";
  return (outcome === "conflicts" && restore === "conflicts") ||
    (outcome === "partial" && (restore === "failed" || (request.action === "pop" && restore === "succeeded")));
}

/** Successful RPC envelopes still contain untrusted data. Validate against the
 * captured request, never the live catalog: a real mutation may have reindexed it.
 * Ignore extra fields so compatible server additions remain usable. */
export function validateStashReceipt(request: StashReceiptRequest, value: unknown): StashReceipt {
  const invalid = () => { throw { code: "invalid_response", message: "The server returned an invalid stash receipt for the submitted action." }; };
  if (!record(value) || value.repositoryId !== request.repositoryId || !receiptError(value.error)) return invalid();
  if (request.action === "selected") {
    if (!(value.stash === null || savedStash(value.stash))) return invalid();
    if (!((value.outcome === "success" && value.stash !== null && value.error === null) ||
      (value.outcome === "noChanges" && value.stash === null && value.error === null) ||
      (value.outcome === "partial" && value.error !== null))) return invalid();
    return value as GitStashPushSelectedResult;
  }
  if (!record(value.target) || !stashSelector(value.target.selector) || !fullOid(value.target.expectedOid) ||
    value.target.selector !== request.target.selector || value.target.expectedOid !== request.target.expectedOid ||
    !["success", "conflicts", "partial", "branchCreatedRestoreFailed"].includes(value.outcome as string) ||
    !["retained", "removed"].includes(value.stashState as string) ||
    !["notAttempted", "succeeded", "conflicts", "failed"].includes(value.restore as string)) return invalid();
  if (value.branch !== null && !(request.action === "branch" && record(value.branch) &&
    value.branch.name === request.name && typeof value.branch.switched === "boolean")) return invalid();
  const receipt = value as GitStashMutationResult;
  if (!mutationMeaning(request, receipt)) return invalid();
  return receipt;
}

// Only explicit pre-mutation rejections prove that nothing ran. In particular,
// request_timeout, transport, client_error and malformed responses do not.
const stashRejectionCodes = new Set([
  "unauthorized", "authentication_required", "forbidden", "unsupported_method",
  "method_not_found", "not_implemented", "invalid_request", "invalid_params",
  "repository_not_configured", "repository_not_found", "server_busy",
  "stash_target_changed", "stale_stash",
]);

function stashFailureNotice(caught: unknown): StashNotice {
  // The Promise adapter and typed RPC errors expose code/message directly;
  // a protocol response envelope carries the same error under `error`.
  const error = typeof caught === "object" && caught !== null && "error" in caught &&
    !("code" in caught) && typeof caught.error === "object" && caught.error !== null
    ? caught.error : caught;
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  const unknown = typeof code !== "string" || !stashRejectionCodes.has(code);
  return {
    tone: unknown ? "warning" : "error",
    title: unknown ? "Stash completion is unknown" : "Stash operation failed",
    description: `${summarizeGitError(error)}${unknown ? " Refresh and inspect the stash and working changes before explicitly trying again. The action was not replayed." : ""}`,
  };
}

export function stashReceiptNotice(action: StashAction | "selected", value: StashReceipt): StashNotice {
  if (action === "selected") {
    const receipt = value as GitStashPushSelectedResult;
    if (receipt.outcome === "noChanges") return { tone: "info", title: "No changes to stash", description: "The selected paths have no changes to save." };
    if (receipt.outcome === "partial") return {
      tone: "warning", title: receipt.stash ? "Stash saved; cleanup incomplete" : "Stash could not be saved",
      description: `${receipt.stash ? "The saved stash is retained. Some selected changes remain in place." : "Review the working changes before trying again."} ${receipt.error ? summarizeGitError(receipt.error) : ""}`.trim(),
    };
    return { tone: "success", title: "Selected changes stashed", description: receipt.stash ? receipt.stash.message : "Selected changes saved." };
  }
  const receipt = value as GitStashMutationResult;
  const retention = receipt.stashState === "removed" ? "The saved stash was removed." : "The saved stash is retained.";
  const branch = receipt.branch ? `Branch ${receipt.branch.name} was created${receipt.branch.switched ? " and checked out" : "; it was not checked out"}. ` : "";
  const progress = receipt.restore === "succeeded" ? "Saved changes restored. " : receipt.restore === "notAttempted" ? "Restoration was not attempted. " : receipt.restore === "conflicts" ? "Resolve the highlighted working changes. " : "Restoration did not complete; review the working changes. ";
  const description = `${branch}${action === "drop" && receipt.outcome === "success" ? "" : progress}${retention}${receipt.error ? ` ${summarizeGitError(receipt.error)}` : ""}`;
  const conflicts = receipt.restore === "conflicts" || receipt.outcome === "conflicts";
  if (receipt.outcome !== "success") return {
    tone: "warning", title: receipt.outcome === "branchCreatedRestoreFailed" ? "Branch created; restoration incomplete" : conflicts ? "Stash restored with conflicts" : "Stash operation incomplete",
    description, conflicts,
  };
  return { tone: "success", title: action === "drop" ? "Stash deleted" : action === "branch" ? "Branch created from stash" : action === "pop" ? "Stash popped" : "Stash applied", description };
}

/** Mutation and refresh are separate outcomes. A retry can only refresh. */
export async function performStashOperation(request: StashReceiptRequest, mutate: () => Promise<unknown>, refresh: () => Promise<unknown>, onReceipt?: (receipt: StashReceipt) => void) {
  let receipt: StashReceipt | undefined;
  let notice: StashNotice;
  try {
    receipt = validateStashReceipt(request, await mutate());
    notice = stashReceiptNotice(request.action, receipt);
    onReceipt?.(receipt);
  } catch (error) {
    notice = stashFailureNotice(error);
  }
  let refreshError: unknown;
  try { await refresh(); } catch (error) { refreshError = error; }
  return { receipt, notice, refreshError };
}
