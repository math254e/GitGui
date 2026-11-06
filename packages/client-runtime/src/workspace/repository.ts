/** A repository ID is meaningful only within the environment that issued it. */
export interface ScopedRepositoryRef {
  readonly environmentId: string;
  readonly repositoryId: string;
}

export function scopedRepositoryKey(ref: ScopedRepositoryRef): string {
  return JSON.stringify([ref.environmentId, ref.repositoryId]);
}

export function sameRepository(left: ScopedRepositoryRef, right: ScopedRepositoryRef): boolean {
  return left.environmentId === right.environmentId && left.repositoryId === right.repositoryId;
}

/**
 * A logical identity is only a grouping hint; all actions still use `ref`.
 * Fallback family keys are scoped to the server that resolved them.
 */
export interface RepositoryGroupMember {
  readonly ref: ScopedRepositoryRef;
  readonly identityKey?: string | null;
  readonly worktreeFamilyKey?: string | null;
}

export interface RepositoryGroup<T extends RepositoryGroupMember> {
  readonly key: string;
  readonly members: readonly T[];
}

export interface ScopedRepositorySummary extends RepositoryGroupMember {
  readonly repository: RepositorySummary;
}

/** Project environment-owned catalog summaries into logical groups. */
export function groupRepositoryCatalogs(
  catalogs: Readonly<Record<string, readonly RepositorySummary[]>>,
): RepositoryGroup<ScopedRepositorySummary>[] {
  const members: ScopedRepositorySummary[] = [];
  for (const [environmentId, repositories] of Object.entries(catalogs)) {
    for (const repository of repositories) {
      members.push({
        ref: { environmentId, repositoryId: repository.id },
        identityKey: repository.repositoryIdentity?.canonicalKey,
        worktreeFamilyKey: repository.worktreeFamily?.id,
        repository,
      });
    }
  }
  return buildRepositoryGroups(members);
}

/**
 * Adapts T3 Code's logical/physical project grouping from
 * packages/client-runtime/src/state/projectGrouping.ts at
 * 70cd258d8aac43ea57494527b00bf36de3efa6c0.
 * GitGui uses host-issued checkout IDs and an environment-scoped worktree
 * family fallback, rather than T3 projects, grouping modes or thread state.
 */
export function buildRepositoryGroups<T extends RepositoryGroupMember>(
  repositories: readonly T[],
): RepositoryGroup<T>[] {
  const groups = new Map<string, T[]>();
  const seen = new Set<string>();
  const identitiesByFamily = new Map<string, Set<string>>();
  for (const repository of repositories) {
    const identity = safeIdentity(repository.identityKey);
    const family = repository.worktreeFamilyKey?.trim();
    if (!identity || !family) continue;
    const key = JSON.stringify([repository.ref.environmentId, family]);
    const identities = identitiesByFamily.get(key) ?? new Set<string>();
    identities.add(identity);
    identitiesByFamily.set(key, identities);
  }
  for (const repository of repositories) {
    const physical = scopedRepositoryKey(repository.ref);
    if (seen.has(physical)) continue;
    seen.add(physical);
    const family = repository.worktreeFamilyKey?.trim();
    const familyIdentities = family
      ? identitiesByFamily.get(JSON.stringify([repository.ref.environmentId, family]))
      : undefined;
    // A known worktree family can recover a missing identity from a sibling,
    // but disagreeing identities are ambiguous and must not be guessed.
    const identity = safeIdentity(repository.identityKey) ||
      (familyIdentities?.size === 1 ? [...familyIdentities][0] : undefined);
    const key = identity
      ? JSON.stringify(["remote", identity])
      : family
        ? JSON.stringify(["family", repository.ref.environmentId, family])
        : JSON.stringify(["checkout", repository.ref.environmentId, repository.ref.repositoryId]);
    const members = groups.get(key);
    if (members) members.push(repository);
    else groups.set(key, [repository]);
  }
  return [...groups].map(([key, members]) => ({ key, members }));
}

function safeIdentity(value: string | null | undefined): string | undefined {
  if (!value || value.length > 4096 || /[\s@?#]/.test(value) || value.includes("://")) return undefined;
  return value;
}
import type { RepositorySummary } from "@gitgui/contracts";
