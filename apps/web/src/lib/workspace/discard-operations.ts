import type { GitDiscardFile, GitDiscardResult } from "@gitgui/contracts";
import { summarizeGitError } from "./errors";

/** An ok:true envelope alone does not prove which destructive targets ran. */
export function validateDiscardReceipt(files: readonly GitDiscardFile[], value: unknown): GitDiscardResult {
  const invalid = () => { throw { code: "invalid_response", message: "The server returned an invalid discard receipt." }; };
  if (!value || typeof value !== "object") return invalid();
  const receipt = value as GitDiscardResult;
  if (!Array.isArray(receipt.completedPaths) || !Array.isArray(receipt.remainingPaths) ||
    !(receipt.error === null || typeof receipt.error === "string" && receipt.error.trim())) return invalid();
  const paths = [...receipt.completedPaths, ...receipt.remainingPaths];
  const expected = new Set(files.map((file) => file.path));
  if (paths.length !== expected.size || new Set(paths).size !== paths.length ||
    paths.some((path) => typeof path !== "string" || !expected.has(path)) ||
    (receipt.error === null && receipt.remainingPaths.length > 0)) return invalid();
  return receipt;
}

const rejections = new Set(["unauthorized", "authentication_required", "forbidden", "invalid_request", "invalid_params", "method_not_found", "repository_not_configured", "repository_not_found", "server_busy"]);

export function discardFailureNotice(caught: unknown) {
  const error = caught && typeof caught === "object" && "error" in caught && !("code" in caught) ? caught.error : caught;
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const uncertain = typeof code !== "string" || !rejections.has(code);
  return {
    uncertain,
    title: uncertain ? "Discard completion is unknown" : "Discard failed",
    description: `${summarizeGitError(error)}${uncertain ? " Refresh and inspect working changes before trying again. Discard was not replayed." : ""}`,
  };
}
