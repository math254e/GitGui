const branchSwitchMergeStorageKey = "gitgui.branchSwitch.merge.v1";
const projectsLocationStorageKey = "gitgui.projectsLocation.v1";

export function readBranchSwitchMergePreference() {
  if (typeof localStorage === "undefined") {
    return false;
  }

  try {
    return localStorage.getItem(branchSwitchMergeStorageKey) === "true";
  } catch {
    return false;
  }
}

export function writeBranchSwitchMergePreference(enabled: boolean) {
  if (typeof localStorage === "undefined") {
    return;
  }

  try {
    localStorage.setItem(branchSwitchMergeStorageKey, String(enabled));
  } catch {
    // Preferences are best-effort and must not affect repository operations.
  }
}

export function readProjectsLocationPreference(): string | null {
  if (typeof localStorage === "undefined") {
    return null;
  }

  try {
    const value = localStorage.getItem(projectsLocationStorageKey)?.trim();
    return value || null;
  } catch {
    return null;
  }
}

export function writeProjectsLocationPreference(location: string) {
  if (typeof localStorage === "undefined") {
    return;
  }

  try {
    const value = location.trim();
    if (value) {
      localStorage.setItem(projectsLocationStorageKey, value);
    } else {
      localStorage.removeItem(projectsLocationStorageKey);
    }
  } catch {
    // Preferences are best-effort and must not affect repository operations.
  }
}

export async function resolveProjectsLocation(): Promise<string> {
  const stored = readProjectsLocationPreference();
  if (stored) {
    return stored;
  }

  return "";
}
