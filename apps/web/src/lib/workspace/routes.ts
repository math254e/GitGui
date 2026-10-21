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

/** The route id SvelteKit reports for the repositories home page. */
export const HOME_ROUTE_ID = "/";

/** The route id SvelteKit reports for the create repository page. */
export const NEW_REPOSITORY_ROUTE_ID = "/new";

/** The route id prefix every settings page shares. */
export const SETTINGS_ROUTE_PREFIX = "/settings";

export function repositoryPath(repositoryId: string): string {
  return `/repo/${encodeURIComponent(repositoryId)}`;
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
