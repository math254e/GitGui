import type { StashInfo } from "../types/repository";
import type { StashActionContext } from "./types";

/** Copy the reviewed identity; never resolve a queued action from live selection. */
export function captureStashActionContext(
  environmentId: string,
  repositoryId: string,
  stash: StashInfo,
): StashActionContext {
  return {
    environmentId,
    repositoryId,
    target: { selector: stash.selector, expectedOid: stash.hash },
  };
}

/** A reindexed/replaced/removed entry clears selection, including its open diff.
 * Matching both fields also avoids silently picking another copy of the same OID.
 */
export function reconcileSelectedStash(stash: StashInfo, stashes: readonly StashInfo[]): StashInfo | null {
  return stashes.find((entry) => entry.selector === stash.selector && entry.hash === stash.hash) ?? null;
}

/** The caller supplies the selection of the clicked staging section only. */
export function stashContextPaths(clickedPath: string, selectedPaths: readonly string[]): string[] {
  return selectedPaths.includes(clickedPath) ? [...new Set(selectedPaths)] : [clickedPath];
}
