const branchSwitchMergeStorageKey = "gitgui.branchSwitch.merge.v1";

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
