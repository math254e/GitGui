/**
 * Desktop deep links.
 *
 * The desktop shell forwards a `gitgui://` link to the renderer. The host
 * names the target, so a link can name a repository or a settings page
 * without carrying anything secret.
 */
import { repositoryPath, scopedRepositoryPath } from "./routes";

export const DEEP_LINK_PROTOCOL = "gitgui:";

/**
 * Resolve a deep link to an application path.
 *
 * `gitgui://repo/<repositoryId>` opens a repository and `gitgui://settings`
 * opens the settings. `gitgui://repo/<environmentId>/<repositoryId>` is scoped.
 * Legacy IDs deliberately remain legacy paths: the route resolves ambiguity
 * using saved migration context/catalogs, never the active tab's environment.
 */
export function resolveDeepLinkTarget(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== DEEP_LINK_PROTOCOL || url.username || url.password || url.port || url.search || url.hash) return null;

  let segments: string[];
  try {
    const path = url.pathname.replace(/^\//, "").replace(/\/$/, "");
    segments = path ? path.split("/").map((segment) => decodeURIComponent(segment)) : [];
    if (segments.some((segment) => !segment.trim())) return null;
  } catch {
    return null;
  }

  if (url.hostname === "repo" && segments.length === 1) {
    return repositoryPath(segments[0]);
  }

  if (url.hostname === "repo" && segments.length === 2) {
    return scopedRepositoryPath(segments[0], segments[1]);
  }

  if (url.hostname === "settings" && segments.length === 0) {
    return "/settings/general";
  }

  return null;
}
