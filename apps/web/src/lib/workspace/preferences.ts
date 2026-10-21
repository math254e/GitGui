import type { LayoutStorage } from "./types";

const layoutStorageKey = "gitgui.workspaceLayout.v1";
const branchGraphVisibilityStoragePrefix = "gitgui.branchGraphVisibility.v1";

export function readLayoutPreferences(): LayoutStorage {
  const stored = localStorage.getItem(layoutStorageKey);
  if (!stored) return {};

  try {
    const parsed = JSON.parse(stored) as LayoutStorage;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    localStorage.removeItem(layoutStorageKey);
    return {};
  }
}

export function persistLayoutPreferences(value: LayoutStorage): void {
  localStorage.setItem(layoutStorageKey, JSON.stringify(value));
}

function branchVisibilityStorageKey(key: string): string {
  return `${branchGraphVisibilityStoragePrefix}:${encodeURIComponent(key)}`;
}

export function readHiddenGraphRefKeys(key: string): Set<string> {
  try {
    const stored = localStorage.getItem(branchVisibilityStorageKey(key));
    if (!stored) {
      return new Set<string>();
    }

    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) {
      return new Set<string>();
    }

    return new Set(parsed.filter((value): value is string => typeof value === "string"));
  } catch {
    return new Set<string>();
  }
}

export function persistHiddenGraphRefKeys(key: string | null, hiddenKeys: ReadonlySet<string>): void {
  if (!key) {
    return;
  }

  try {
    localStorage.setItem(branchVisibilityStorageKey(key), JSON.stringify([...hiddenKeys]));
  } catch {
    // Graph visibility is a best-effort client preference.
  }
}
