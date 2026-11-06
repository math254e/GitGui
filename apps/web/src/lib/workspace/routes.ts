/**
 * The application's route vocabulary.
 *
 * Routes are the only place a URL shape is written down. Everything that
 * navigates goes through these helpers so the path of a repository or a
 * settings page is defined exactly once.
 */

export const SETTINGS_SECTIONS = ["general", "appearance", "connections"] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** The route id SvelteKit reports for the repository workspace. */
export const REPOSITORY_ROUTE_ID = "/repo/[repositoryId]";
export const SCOPED_REPOSITORY_ROUTE_ID = "/repo/(scoped)/[environmentId]/[repositoryId]";

export type RepositoryRouteRequest =
  | { readonly kind: "legacy"; readonly repositoryId: string }
  | { readonly kind: "scoped"; readonly target: { readonly environmentId: string; readonly repositoryId: string } };

export function isRepositoryRouteId(routeId: string | null): boolean {
  return routeId === REPOSITORY_ROUTE_ID || routeId === SCOPED_REPOSITORY_ROUTE_ID;
}

/** SvelteKit has already decoded params. Never infer an environment from selection. */
export function repositoryRouteFromParams(
  routeId: string | null,
  params: { readonly repositoryId?: string; readonly environmentId?: string },
): RepositoryRouteRequest | null {
  const repositoryId = repositoryIdFromParam(params.repositoryId);
  if (!repositoryId) return null;
  if (routeId === REPOSITORY_ROUTE_ID) return { kind: "legacy", repositoryId };
  const environmentId = repositoryIdFromParam(params.environmentId);
  return routeId === SCOPED_REPOSITORY_ROUTE_ID && environmentId
    ? { kind: "scoped", target: { environmentId, repositoryId } }
    : null;
}

/** The route id SvelteKit reports for the repositories home page. */
export const HOME_ROUTE_ID = "/";

/** The route id SvelteKit reports for the create repository page. */
export const NEW_REPOSITORY_ROUTE_ID = "/new";

/** The route id prefix every settings page shares. */
export const SETTINGS_ROUTE_PREFIX = "/settings";

export function repositoryPath(repositoryId: string): string {
  return `/repo/${encodeURIComponent(repositoryId)}`;
}

/** Canonical repository URL. The route group is absent from the public path. */
export function scopedRepositoryPath(environmentId: string, repositoryId: string): string {
  return `/repo/${encodeURIComponent(environmentId)}/${encodeURIComponent(repositoryId)}`;
}

export function settingsPath(section: SettingsSection): string {
  return `${SETTINGS_ROUTE_PREFIX}/${section}`;
}

export function isSettingsRouteId(routeId: string | null): boolean {
  return routeId === SETTINGS_ROUTE_PREFIX || routeId?.startsWith(`${SETTINGS_ROUTE_PREFIX}/`) === true;
}

/** A repository id from a route parameter, or null when the route has none. */
export function repositoryIdFromParam(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
