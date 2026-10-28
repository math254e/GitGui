import type { CommitInfo } from "$lib/types/repository";

/** Ancestor tags add badges, but need no extra history root or wire payload. */
export function graphTargets(commits: CommitInfo[], targets: Iterable<string>): string[] {
  const byHash = new Map(commits.map((commit) => [commit.hash, commit]));
  const roots = new Set([...targets].filter((hash) => byHash.has(hash)));
  const pending = [...roots].flatMap((hash) => byHash.get(hash)?.parents ?? []);
  const visited = new Set<string>();
  while (pending.length) {
    const hash = pending.pop()!;
    if (visited.has(hash)) continue;
    visited.add(hash);
    roots.delete(hash);
    for (const parent of byHash.get(hash)?.parents ?? []) pending.push(parent);
  }
  return [...roots];
}
