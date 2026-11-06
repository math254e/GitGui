import { sameRepository, type RepositoryGroup, type ScopedRepositoryRef, type ScopedRepositorySummary } from "@gitgui/client-runtime/workspace";
import type { EnvironmentEntryView } from "$lib/connection/runtime";

export interface RepositoryLocation {
  readonly target: ScopedRepositoryRef;
  readonly path: string;
  readonly missing: boolean;
  readonly current: boolean;
}

export interface RepositoryLocationEnvironment {
  readonly environmentId: string;
  readonly label: string;
  readonly status: string;
  readonly local?: boolean;
  readonly locations: readonly RepositoryLocation[];
}

/** Preserve every clone while showing linked worktrees in their existing section. */
export function repositoryLocations(
  group: RepositoryGroup<ScopedRepositorySummary> | undefined,
  entries: readonly EnvironmentEntryView[],
  current: ScopedRepositoryRef,
  isDesktop: boolean,
): RepositoryLocationEnvironment[] {
  if (!group) return [];
  const environments = new Map(entries.map((entry) => [entry.registration.environmentId, entry]));
  const byEnvironment = new Map<string, ScopedRepositorySummary[]>();
  for (const member of group.members) {
    const members = byEnvironment.get(member.ref.environmentId) ?? [];
    members.push(member);
    byEnvironment.set(member.ref.environmentId, members);
  }
  if (isDesktop && byEnvironment.size === 1 && [...byEnvironment.keys()].every((id) => environments.get(id)?.registration.target.kind === "primary")) return [];
  const result: RepositoryLocationEnvironment[] = [];
  for (const [environmentId, members] of byEnvironment) {
    const entry = environments.get(environmentId);
    if (!entry) continue;
    const families = new Map<string, ScopedRepositorySummary[]>();
    for (const member of members) {
      const family = member.worktreeFamilyKey
        ? JSON.stringify(["family", member.worktreeFamilyKey])
        : JSON.stringify(["checkout", member.ref.repositoryId]);
      const values = families.get(family) ?? [];
      values.push(member);
      families.set(family, values);
    }
    const locations = [...families.values()].map((family) => {
      const selected = family.find((member) => sameRepository(member.ref, current))
        ?? family.find((member) => member.repository.worktreeFamily?.mainRoot === member.repository.root)
        ?? family[0];
      return { target: selected.ref, path: selected.repository.root, missing: selected.repository.missing === true, current: family.some((member) => sameRepository(member.ref, current)) };
    });
    result.push({ environmentId, label: entry.registration.displayName, status: entry.connection.phase, local: isDesktop && entry.registration.target.kind === "primary", locations });
  }
  return result;
}
