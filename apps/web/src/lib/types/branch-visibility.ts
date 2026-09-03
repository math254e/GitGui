import type { CommitRef } from "$lib/types/repository";

/** Stable client-owned identity used for per-repository graph visibility. */
export function graphRefKey(ref: CommitRef) {
  return `${ref.refType}\0${ref.name}`;
}

export function isCurrentBranchRef(ref: CommitRef, currentBranch: string | null | undefined) {
  return ref.refType === "localBranch" && ref.shortName === currentBranch;
}
