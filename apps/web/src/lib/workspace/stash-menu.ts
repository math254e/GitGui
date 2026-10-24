import type { ContextMenuItem } from "../contextMenu";
import type { StashAction } from "./stash-operations";

export type StashCapabilities = Record<StashAction, boolean>;
export const unsupportedStashActions: StashCapabilities = { apply: false, pop: false, drop: false, branch: false };
export function stashMenuItems(capabilities: StashCapabilities): ContextMenuItem<StashAction>[] {
  return [
    { id: "apply", label: "Apply", disabled: !capabilities.apply },
    { id: "pop", label: "Pop…", disabled: !capabilities.pop },
    { id: "drop", label: "Delete…", disabled: !capabilities.drop },
    { id: "branch", label: "Create branch from stash…", disabled: !capabilities.branch },
  ];
}
