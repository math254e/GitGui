/**
 * Desktop deep links.
 *
 * The desktop shell forwards a `gitgui://` link to the renderer. The host
 * names the target, so a link can name a repository or a settings page
 * without carrying anything secret.
 */
import { repositoryPath } from "./routes";

export const DEEP_LINK_PROTOCOL = "gitgui:";

/**
 * Resolve a deep link to an application path.
 *
 * `gitgui://repo/<repositoryId>` opens a repository and `gitgui://settings`
 * opens the settings. Anything else is not a link this client understands.
 */
export function resolveDeepLinkTarget(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== DEEP_LINK_PROTOCOL) return null;

  const segments = url.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment));

  if (url.hostname === "repo" && segments.length === 1) {
    return repositoryPath(segments[0]);
  }

  if (url.hostname === "settings" && segments.length === 0) {
    return "/settings/general";
  }

  return null;
}
