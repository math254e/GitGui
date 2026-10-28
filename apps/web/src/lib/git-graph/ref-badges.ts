import type { CommitRef } from "$lib/types/repository";

export type RefBadges = { refs: CommitRef[]; additionalTags: number };

/** Build once per ref update; scrolling and hovering only look up visible rows. */
export function buildRefBadges(refsByTarget: ReadonlyMap<string, CommitRef[]>): Map<string, RefBadges> {
  const badges = new Map<string, RefBadges>();
  for (const [target, refs] of refsByTarget) {
    let tagCount = 0;
    const shown = refs.filter((ref) => ref.refType !== "tag" || ++tagCount <= 3);
    badges.set(target, { refs: shown, additionalTags: Math.max(0, tagCount - 3) });
  }
  return badges;
}
