/**
 * The agreement between the URL and the workspace.
 *
 * The URL owns what is on screen. The workspace owns which repositories are
 * open. These pure helpers decide what one side asks the other to do, so the
 * rule can be tested without a browser.
 */
import { repositoryPath } from "./routes";

/** What the repository route asks the workspace to do. */
export type RouteIntent =
  | { kind: "none" }
  | { kind: "select"; repositoryId: string }
  | { kind: "open"; repositoryId: string };

/**
 * Resolve the repository the URL points at.
 *
 * A repository that is already open only needs to become the active one. A
 * repository that is not open has to be opened first.
 */
export function resolveRouteIntent(input: {
  readonly routedRepositoryId: string | null;
  readonly openRepositoryIds: readonly string[];
  readonly activeRepositoryId: string | null;
}): RouteIntent {
  const repositoryId = input.routedRepositoryId;
  if (!repositoryId) return { kind: "none" };
  if (!input.openRepositoryIds.includes(repositoryId)) {
    return { kind: "open", repositoryId };
  }
  if (input.activeRepositoryId !== repositoryId) {
    return { kind: "select", repositoryId };
  }
  return { kind: "none" };
}

/**
 * Where to go when the routed repository is closed.
 *
 * The next open repository takes the URL, or the repositories home page when
 * the closed tab was the last one.
 */
export function resolveClosedRepositoryTarget(activeRepositoryId: string | null): string {
  return activeRepositoryId ? repositoryPath(activeRepositoryId) : "/";
}
