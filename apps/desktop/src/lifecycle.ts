export function extractDeepLink(argumentsList: readonly string[]): string | null {
  for (let index = argumentsList.length - 1; index >= 0; index -= 1) {
    const candidate = normalizeDeepLink(argumentsList[index]);
    if (candidate) return candidate;
  }
  return null;
}

export function normalizeDeepLink(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 8_192 || !value.startsWith("gitgui://")) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "gitgui:" || url.hostname === "app" || url.username || url.password || url.hash) return null;
    const sensitiveKeys = ["token", "credential", "password", "authorization", "bootstrap"];
    if (sensitiveKeys.some((key) => url.searchParams.has(key))) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function normalizeUpdateFeedUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}
